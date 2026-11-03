import { describe, expect, it } from "vitest";
import { Who } from "@desert-ant-labs/who";
import {
  createWhoFetch,
  createWhoRuntimeFetch,
  WHO_FILES,
  WHO_MODEL_BASE_URL,
  WHO_REVISION,
} from "./who-integrity";

const fileNames = Object.keys(WHO_FILES);
const testBytes: Record<string, Uint8Array<ArrayBuffer>> = Object.fromEntries(
  fileNames.map((name) => [name, new TextEncoder().encode(`fixture:${name}`)]),
);

async function testManifest() {
  return Object.fromEntries(
    await Promise.all(
      fileNames.map(async (name) => {
        const bytes = testBytes[name];
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        return [
          name,
          {
            digest: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
            size: bytes.byteLength,
          },
        ];
      }),
    ),
  );
}

function fakeCacheStorage() {
  const files = new Map<string, Response>();
  const cache = {
    match: async (url: string) => files.get(url)?.clone(),
    delete: async (url: string) => files.delete(url),
    put: async (url: string, response: Response) => {
      files.set(url, response.clone());
    },
  };
  return { files, storage: { open: async () => cache } };
}

function responseFor(url: string, bytes: Uint8Array<ArrayBuffer>) {
  const response = new Response(bytes, { status: 200 });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("Who pinned model loading", () => {
  it("resolves only known bare LiteRT WASM filenames against the local runtime directory", async () => {
    const requests: (RequestInfo | URL)[] = [];
    const fetch = createWhoRuntimeFetch(async (input) => {
      requests.push(input);
      return new Response();
    }, new URL("tauri://localhost/litert/"));

    await fetch("litert_wasm_internal.wasm");
    await fetch("litert_wasm_compat_internal.wasm");
    await fetch("litert_wasm_threaded_internal.wasm");
    await fetch("litert_wasm_jspi_internal.wasm");
    await fetch("other.wasm");

    expect(requests.slice(0, 4).map(String)).toEqual([
      "tauri://localhost/litert/litert_wasm_internal.wasm",
      "tauri://localhost/litert/litert_wasm_compat_internal.wasm",
      "tauri://localhost/litert/litert_wasm_threaded_internal.wasm",
      "tauri://localhost/litert/litert_wasm_jspi_internal.wasm",
    ]);
    expect(requests[4]).toBe("other.wasm");
  });

  it("pins every model artifact with SHA-256", () => {
    expect(Object.values(WHO_FILES).every(({ digest }) => /^[a-f0-9]{64}$/.test(digest))).toBe(
      true,
    );
    expect(WHO_FILES["litert-int8/who_meta.json"]).toEqual({
      digest: "6321db030dcff196a694610c047cb10f632ab95420746dae67723bd46c13c273",
      size: 4_090,
    });
    expect(WHO_FILES["litert-int8/who_mel_banks.f32"].digest).toBe(
      "730d76d5d2099d964c705c82c4556e2b10792d287666aa97edb0633f88f08ce0",
    );
    expect(WHO_FILES["litert-int8/who_voice_banks.f32"].digest).toBe(
      "df33ff45ac021f5d014356b4e9ab4b9f91fadd836649962ee6e89eadfcd264e3",
    );
  });

  it("rejects wrong origin, revision, and unknown model files without fetching", async () => {
    const fetch = createWhoFetch(async () => {
      throw new Error("unexpected network request");
    });
    const known = `${WHO_MODEL_BASE_URL}${fileNames[0]}`;
    await expect(fetch(known.replace("huggingface.co", "attacker.invalid"))).rejects.toThrow(
      "Unexpected Who model URL",
    );
    await expect(fetch(known.replace(WHO_REVISION, "v0.3.4"))).rejects.toThrow(
      "Unexpected Who model URL",
    );
    await expect(fetch(`${WHO_MODEL_BASE_URL}litert-int8/unknown.tflite`)).rejects.toThrow(
      "Unexpected Who model file",
    );
  });

  it("rejects responses redirected outside the Hub's known model hosts", async () => {
    const manifest = await testManifest();
    const name = fileNames[0];
    const fetch = createWhoFetch(
      async () => responseFor("https://attacker.cdn.hf.co/payload", testBytes[name]),
      {
        files: manifest,
        cacheStorage: fakeCacheStorage().storage,
      },
    );
    await expect(fetch(`${WHO_MODEL_BASE_URL}${name}`)).rejects.toThrow(
      "Unexpected Who model redirect",
    );
  });

  it("runs the installed Who.load path with verified synthetic model files and cache", async () => {
    const manifest = await testManifest();
    const { files, storage } = fakeCacheStorage();
    const requests: string[] = [];
    let tamperedFile: string | null = null;
    const originalFetch = globalThis.fetch;
    const networkFetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      const name = url.slice(WHO_MODEL_BASE_URL.length);
      let bytes = testBytes[name];
      if (!bytes) throw new Error(`unexpected synthetic request: ${url}`);
      if (name === tamperedFile) bytes = new Uint8Array(bytes.length).fill(0x41);
      return responseFor(url, bytes);
    };
    globalThis.fetch = createWhoFetch(networkFetch, { cacheStorage: storage, files: manifest });

    const compileReached = new Error("synthetic compile reached");
    const litert = {
      loadLiteRt: async () => undefined,
      Tensor: class {},
      loadAndCompile: async () => {
        throw compileReached;
      },
    };
    const loadWho = () =>
      Who.load({
        litert,
        modelBaseUrl: WHO_MODEL_BASE_URL,
        accelerator: "wasm",
      });

    try {
      await expect(loadWho()).rejects.toBe(compileReached);
      expect(requests).toHaveLength(fileNames.length);
      expect(files.size).toBe(fileNames.length);

      const metadataUrl = `${WHO_MODEL_BASE_URL}litert-int8/who_meta.json`;
      files.delete(metadataUrl);
      tamperedFile = "litert-int8/who_meta.json";
      requests.length = 0;
      await expect(loadWho()).rejects.toThrow("Who model integrity check failed");
      expect(requests).toEqual([metadataUrl]);
      expect(files.has(metadataUrl)).toBe(false);

      const modelUrl = `${WHO_MODEL_BASE_URL}${fileNames[0]}`;
      files.set(modelUrl, responseFor(modelUrl, new TextEncoder().encode("tampered")));
      tamperedFile = null;
      requests.length = 0;
      await expect(loadWho()).rejects.toBe(compileReached);
      expect(requests.sort()).toEqual([metadataUrl, modelUrl].sort());
      expect(files.size).toBe(fileNames.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
