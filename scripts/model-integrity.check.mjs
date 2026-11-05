import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createVozFetch,
  removeInvalidVozCache,
  VOZ_FILES,
  VOZ_REVISION,
  verifyVozResponse,
} from "../src-tauri/sidecar/model-integrity.mjs";

test("Voz assets are accepted only under the pinned commit and known hashes", () => {
  assert.deepEqual(VOZ_FILES["meta.json"], [
    "sha256",
    "2fb6b111dcf4f2477d7ff7699b2374c5f7194ae5fa20ef2a06f121c243119a37",
  ]);
  assert.deepEqual(VOZ_FILES["vocab.json"], [
    "sha256",
    "3eb2f73e8853dce5156c2ed97c0b1bb84eb4ebd201eb1761d15977fc1ea31490",
  ]);
  const url = `https://huggingface.co/desert-ant-labs/voz/resolve/${VOZ_REVISION}/web/decoder.onnx`;
  assert.throws(() => verifyVozResponse(url, new Uint8Array([0])), /integrity check failed/);
  assert.throws(
    () => verifyVozResponse(url.replace(VOZ_REVISION, "v0.5.0"), new Uint8Array()),
    /Unexpected Voz model URL/,
  );
});

test("production Voz fetch adapter rejects unpinned model requests and preserves license requests", async () => {
  const calls = [];
  const fetch = createVozFetch(async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const response = new Response("tampered");
    Object.defineProperty(response, "url", { value: String(url) });
    return response;
  });
  const base = `https://huggingface.co/desert-ant-labs/voz/resolve/${VOZ_REVISION}/web/`;
  await assert.rejects(fetch(`${base}unknown.onnx`), /Unexpected Voz model file/);
  await assert.rejects(
    fetch(`${base.replace(VOZ_REVISION, "v0.5.0")}decoder.onnx`),
    /Unexpected Voz model URL/,
  );
  await assert.rejects(
    fetch(`${base.replace("huggingface.co", "attacker.invalid")}decoder.onnx`),
    /Unexpected Voz model URL/,
  );
  await assert.rejects(
    fetch(`${base}decoder.onnx`, { method: "POST" }),
    /Unexpected Voz model method/,
  );
  await assert.rejects(
    fetch("https://attacker.invalid/unmarked/external"),
    /Unexpected Voz external request/,
  );
  await assert.rejects(fetch(`${base}decoder.onnx`), /integrity check failed/);
  assert.equal(calls.length, 1);
  const wrongRedirectFetch = createVozFetch(async () => {
    const response = new Response("tampered");
    Object.defineProperty(response, "url", { value: "https://attacker.cdn.hf.co/payload" });
    return response;
  });
  await assert.rejects(wrongRedirectFetch(`${base}decoder.onnx`), /Unexpected Voz model redirect/);
  const licenseUrl = "https://events.desertant.com/api/v1/license";
  const licenseResponse = await fetch(licenseUrl, { method: "POST", body: "{}" });
  assert.equal(await licenseResponse.text(), "tampered");
  const activateUrl = "https://events.desertant.com/api/v1/activate";
  await fetch(activateUrl, { method: "POST", body: "{}" });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.slice(1), [
    { url: licenseUrl, method: "POST" },
    { url: activateUrl, method: "POST" },
  ]);
  for (const rejected of [
    "https://events.attacker.invalid/api/v1/license",
    "https://events.desertant.com/api/v1/license/extra",
    "https://events.desertant.com/api/v1/other",
    "https://events.desertant.com/api/v1/activate?next=https://attacker.invalid",
  ]) {
    await assert.rejects(
      fetch(rejected, { method: "POST", body: "{}" }),
      /Unexpected Voz external request/,
    );
  }
  await assert.rejects(fetch(licenseUrl, { method: "GET" }), /Unexpected Voz external request/);
  await assert.rejects(
    fetch(activateUrl, { method: "PUT", body: "{}" }),
    /Unexpected Voz external request/,
  );
  assert.equal(calls.length, 3);
  const wrongLicenseRedirect = createVozFetch(async () => {
    const response = new Response("{}", { status: 200 });
    Object.defineProperty(response, "url", { value: "https://attacker.invalid/api/v1/license" });
    return response;
  });
  await assert.rejects(
    wrongLicenseRedirect(licenseUrl, { method: "POST", body: "{}" }),
    /Unexpected Voz license redirect/,
  );
});

test("Voz fetch validates redirect hops before requesting them", async () => {
  const base = `https://huggingface.co/desert-ant-labs/voz/resolve/${VOZ_REVISION}/web/decoder.onnx`;
  const calls = [];
  const fetch = createVozFetch(async (url, init) => {
    calls.push({ url: String(url), redirect: init?.redirect, headers: new Headers(init?.headers) });
    if (calls.length === 1)
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.invalid/file" },
      });
    return new Response("unexpected");
  });
  await assert.rejects(fetch(base, { redirect: "follow" }), /Unexpected Voz model redirect/);
  assert.equal(calls.length, 1);

  calls.length = 0;
  const redirects = [
    "http://huggingface.co/file",
    "https://user@huggingface.co/file",
    "https://huggingface.co/file#fragment",
  ];
  for (const location of redirects) {
    const guarded = createVozFetch(async (url) => {
      calls.push(String(url));
      return new Response(null, { status: 302, headers: { location } });
    });
    await assert.rejects(guarded(base), /Unexpected Voz model redirect/);
  }
  assert.equal(calls.length, redirects.length);

  calls.length = 0;
  const hubChain = createVozFetch(async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init.headers).get("authorization") });
    if (calls.length === 1)
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn-lfs.huggingface.co/signed?token=ok" },
      });
    return new Response("not the pinned model");
  });
  await assert.rejects(
    hubChain(base, { headers: { authorization: "Bearer secret" } }),
    /integrity check failed/,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].authorization, null);

  const metaUrl = `https://huggingface.co/desert-ant-labs/voz/resolve/${VOZ_REVISION}/web/meta.json`;
  // Byte-exact 539-byte response from the immutable pinned URL; SHA-256 is VOZ_FILES.meta.json.
  const pinnedMeta = Buffer.from(
    "eyJzYW1wbGVfcmF0ZSI6IDE2MDAwLCAiaG9wX2xlbmd0aCI6IDE2MCwgIm5fc2FtcGxlcyI6IDI0MDAwMCwgIm5fcm93cyI6IDE1MDMsICJuX21lbHMiOiAxMjgsICJuX2ZmdCI6IDUxMiwgInByZWVtcGgiOiAwLjk3LCAibl9wYWRkZWRfc2FtcGxlcyI6IDI0MDQ4MCwgInZhbGlkX2ZyYW1lcyI6IDE1MDAsICJlbmNfZnJhbWVzIjogMTg4LCAiam9pbnRfaGlkZGVuIjogNjQwLCAicHJlZF9oaWRkZW4iOiA2NDAsICJwcmVkX2xheWVycyI6IDIsICJ2b2NhYl9zaXplIjogODE5MiwgImJsYW5rX2lkeCI6IDgxOTIsICJkdXJhdGlvbnMiOiBbMCwgMSwgMiwgMywgNF0sICJkZWNvZGVfd2lkdGgiOiAyLCAiZnVzZWRfZnJvbnRlbmQiOiB0cnVlLCAiZGVjb2RlX2xhbmVzIjogMTYsICJlbmNvZGVfYmF0Y2giOiA2LCAicHJlY2lzaW9uIjogImZsb2F0MTYiLCAid2ViZ3B1X2RlY29kZXIiOiB7ImZpbGUiOiAiZGVjb2Rlci53ZWJncHUub25ueCIsICJkZWNvZGVfbGFuZXMiOiA0OH0sICJlbmNvZGVyX2V4dGVybmFsIjogImVuY29kZXIub25ueC5kYXRhIn0=",
    "base64",
  );
  const metaCalls = [];
  const verifiedMetaFetch = createVozFetch(async (url, init) => {
    const requestUrl = url instanceof Request ? url.url : String(url);
    metaCalls.push({ url: requestUrl, redirect: init?.redirect });
    if (metaCalls.length === 1)
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn-lfs.huggingface.co/meta?signature=valid" },
      });
    return new Response(pinnedMeta, { headers: { "content-type": "application/json" } });
  });
  const verifiedMeta = await verifiedMetaFetch(metaUrl, { redirect: "follow" });
  assert.deepEqual(Buffer.from(await verifiedMeta.arrayBuffer()), pinnedMeta);
  assert.deepEqual(metaCalls, [
    { url: metaUrl, redirect: "manual" },
    { url: "https://cdn-lfs.huggingface.co/meta?signature=valid", redirect: "manual" },
  ]);
  await assert.rejects(
    createVozFetch(
      async (_url, _init) => new Response(Buffer.concat([pinnedMeta, Buffer.from("x")])),
    )(metaUrl),
    /integrity check failed/,
  );

  for (const request of [
    new Request(metaUrl, {
      headers: {
        authorization: "Bearer request",
        cookie: "session=request",
        "proxy-authorization": "Basic request",
      },
    }),
    new Request(metaUrl, { headers: { authorization: "Bearer overridden" } }),
  ]) {
    const seenHeaders = [];
    const requestFetch = createVozFetch(async (_url, init) => {
      seenHeaders.push(new Headers(init.headers));
      if (seenHeaders.length === 1)
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn-lfs.huggingface.co/meta" },
        });
      return new Response(pinnedMeta);
    });
    const init =
      request.headers.get("authorization") === "Bearer overridden"
        ? {
            headers: {
              authorization: "Bearer init",
              cookie: "session=init",
              "proxy-authorization": "Basic init",
            },
          }
        : undefined;
    await requestFetch(request, init);
    assert.equal(seenHeaders[0].has("authorization"), true);
    assert.equal(seenHeaders[1].has("authorization"), false);
    assert.equal(seenHeaders[1].has("cookie"), false);
    assert.equal(seenHeaders[1].has("proxy-authorization"), false);
  }

  const missingLocation = createVozFetch(async () => new Response(null, { status: 302 }));
  await assert.rejects(missingLocation(base), /missing location/);
  let redirectCount = 0;
  const tooManyRedirects = createVozFetch(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: `https://huggingface.co/redirect/${redirectCount++}` },
      }),
  );
  await assert.rejects(tooManyRedirects(base), /Unexpected Voz model redirect/);
  assert.equal(redirectCount, 11);

  const licenseCalls = [];
  const licenseFetch = createVozFetch(async (...args) => {
    licenseCalls.push(args);
    return new Response(null, {
      status: licenseCalls.length === 1 ? 307 : 308,
      headers: { location: "https://evil.invalid/license" },
    });
  });
  for (const _status of [307, 308]) {
    await assert.rejects(
      licenseFetch("https://events.desertant.com/api/v1/license", {
        method: "POST",
        body: "secret",
        redirect: "follow",
      }),
    );
    assert.equal(licenseCalls.at(-1)[1].redirect, "error");
  }
  assert.equal(licenseCalls.length, 2);
});

test("tampered Voz cache entries are removed before the SDK reads them", async () => {
  const root = await mkdtemp(join(tmpdir(), "voz-integrity-"));
  const previousRoot = process.env.DAL_CACHE_ROOT;
  const cache = join(root, "desert-ant-models/desert-ant-labs/voz", VOZ_REVISION, "web");
  const file = join(cache, "decoder.onnx");
  try {
    process.env.DAL_CACHE_ROOT = root;
    await mkdir(cache, { recursive: true });
    await writeFile(file, "tampered");
    await removeInvalidVozCache();
    await assert.rejects(stat(file), { code: "ENOENT" });
  } finally {
    if (previousRoot === undefined) delete process.env.DAL_CACHE_ROOT;
    else process.env.DAL_CACHE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("sidecar reports missing audio without installed inference dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "sidecar-usage-"));
  const sidecar = join(root, "sidecar");
  await mkdir(sidecar);
  try {
    for (const file of ["server.mjs", "model-integrity.mjs", "ort-thread-options.mjs"]) {
      await copyFile(new URL(`../src-tauri/sidecar/${file}`, import.meta.url), join(sidecar, file));
    }
    const result = spawnSync(process.execPath, [join(sidecar, "server.mjs")], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      type: "error",
      message: "usage: node server.mjs <audio.wav>",
    });
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LiteRT worker does not load executable code from a remote URL", async () => {
  const worker = await readFile(
    new URL("../src/features/transcription/diarization-worker.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(worker, /https?:\/\/|importScripts\s*\(/);
  assert.match(
    worker,
    /litertWasmDir: new URL\(\/\* @vite-ignore \*\/ "\/litert\/", import\.meta\.url\)/,
  );
  const viteConfig = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(viteConfig, /fileName: `litert\/\$\{name\}`/);
});
