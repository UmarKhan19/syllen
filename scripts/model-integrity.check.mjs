import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

test("sidecar resolves public Voz exports and exits before model loading without an audio path", () => {
  const server = new URL("../src-tauri/sidecar/server.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [server.pathname], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).message, "usage: node server.mjs <audio.wav>");
  assert.doesNotMatch(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
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
