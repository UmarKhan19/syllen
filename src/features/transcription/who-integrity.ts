export const WHO_REVISION = "f026f4604f874e2cfe6b817e5123c2b64a56683d";
export const WHO_MODEL_BASE_URL = `https://huggingface.co/desert-ant-labs/who/resolve/${WHO_REVISION}/`;
const WHO_REPO_PATH = "/desert-ant-labs/who/resolve/";
const WHO_CACHE = `syllen-who-${WHO_REVISION}`;
const LITERT_WASM_FILES = new Set([
  "litert_wasm_internal.wasm",
  "litert_wasm_compat_internal.wasm",
  "litert_wasm_threaded_internal.wasm",
  "litert_wasm_jspi_internal.wasm",
]);

// v0.3.4 resolves to WHO_REVISION. Small regular files' SHA-256 values were
// computed after their bytes matched the immutable tree's Git blob IDs.
type ModelFile = { digest: string; size: number };
type ModelFiles = Record<string, ModelFile>;

export const WHO_FILES: ModelFiles = {
  "litert-int8/who.tflite": {
    digest: "083ab7ef3b3d3b9d7a1b5c701c91e24b5310b87caa1be20a343da6968346860e",
    size: 30_574_096,
  },
  "litert-int8/who_embed.f16": {
    digest: "2f2cb55e4370c30b3d5f0401bf421e018fcc8633f5d3aef225375704c60a8c1c",
    size: 2_621_960,
  },
  "litert-int8/who_meta.json": {
    digest: "6321db030dcff196a694610c047cb10f632ab95420746dae67723bd46c13c273",
    size: 4_090,
  },
  "litert-int8/who_mel_banks.f32": {
    digest: "730d76d5d2099d964c705c82c4556e2b10792d287666aa97edb0633f88f08ce0",
    size: 23_652,
  },
  "litert-int8/who_voice_banks.f32": {
    digest: "df33ff45ac021f5d014356b4e9ab4b9f91fadd836649962ee6e89eadfcd264e3",
    size: 82_248,
  },
};

type ModelCache = Pick<Cache, "match" | "delete" | "put">;
type ModelCacheStorage = { open(name: string): Promise<ModelCache> };

async function verifyFile(
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  files: ModelFiles,
): Promise<void> {
  const expected = files[name];
  if (!expected || bytes.byteLength !== expected.size) {
    throw new Error(`Unexpected Who model file or size: ${name}`);
  }
  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hex !== expected.digest) throw new Error(`Who model integrity check failed: ${name}`);
}

function isWhoModelRequest(url: URL): boolean {
  return (
    url.pathname.includes("/desert-ant-labs/who/") ||
    url.pathname.includes("/litert-int8/") ||
    url.pathname.includes("/resolve/")
  );
}

function requestedFile(url: URL, files: ModelFiles): string {
  const prefix = `${WHO_REPO_PATH}${WHO_REVISION}/`;
  if (
    url.origin !== "https://huggingface.co" ||
    !url.pathname.startsWith(prefix) ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Unexpected Who model URL: ${url.href}`);
  }
  const name = url.pathname.slice(prefix.length);
  if (!Object.keys(files).includes(name)) throw new Error(`Unexpected Who model file: ${name}`);
  return name;
}

function allowedRedirect(response: Response): boolean {
  if (!response.url) return true;
  const host = new URL(response.url).hostname;
  return (
    host === "huggingface.co" ||
    host === "cas-bridge.xethub.hf.co" ||
    /^(?:us|eu|ap|sa|me|af)\.aws\.cdn\.hf\.co$/.test(host) ||
    host === "cdn-lfs.huggingface.co" ||
    /^cdn-lfs-(?:us|eu)-\d+\.hf\.co$/.test(host)
  );
}

export function createWhoFetch(
  fetchImpl: typeof fetch,
  options: {
    cacheStorage?: ModelCacheStorage;
    files?: ModelFiles;
  } = {},
): typeof fetch {
  const files = options.files ?? WHO_FILES;
  const cacheStorage = options.cacheStorage ?? globalThis.caches;
  let cachePromise: Promise<ModelCache | null> | undefined;

  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl, globalThis.location?.href ?? WHO_MODEL_BASE_URL);
    if (!isWhoModelRequest(url)) return fetchImpl(input, init);
    const name = requestedFile(url, files);
    cachePromise ??= cacheStorage?.open(WHO_CACHE).catch(() => null) ?? Promise.resolve(null);
    const cache = await cachePromise;
    const cached = await cache?.match(url.href);
    if (cached) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      try {
        await verifyFile(name, bytes, files);
        return new Response(bytes, {
          status: cached.status,
          statusText: cached.statusText,
          headers: cached.headers,
        });
      } catch {
        if (cache) await cache.delete(url.href);
      }
    }

    const response = await fetchImpl(input, init);
    if (!response.ok) throw new Error(`Who model fetch failed: HTTP ${response.status}`);
    if (!allowedRedirect(response))
      throw new Error(`Unexpected Who model redirect: ${response.url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await verifyFile(name, bytes, files);
    const verified = new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    await cache?.put(url.href, verified.clone()).catch(() => {});
    return verified;
  };
}

export function createWhoRuntimeFetch(fetchImpl: typeof fetch, runtimeDir: URL): typeof fetch {
  return (input, init) => {
    if (typeof input === "string" && LITERT_WASM_FILES.has(input)) {
      return fetchImpl(new URL(input, runtimeDir), init);
    }
    return fetchImpl(input, init);
  };
}
