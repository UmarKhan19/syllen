import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const VOZ_REVISION = "12802bf4e2b5e97e1289b723bc6283b6f1a1ace5";
const VOZ_REPO = "desert-ant-labs/voz";
const VOZ_PREFIX = `/${VOZ_REPO}/resolve/${VOZ_REVISION}/web/`;

// Expected SHA-256 for regular text files was computed after verifying their
// immutable Hub tree Git blob IDs; model files retain the Hub LFS SHA-256.
export const VOZ_FILES = {
  "decoder.onnx": ["sha256", "9bf9cb1557f98ab2e5b3ff982fa605827354efc20f2b247c722cab9adf10bd4f"],
  "decoder.webgpu.onnx": [
    "sha256",
    "e80bef7b3b1984cb6f11fd057b2dc1f1af8db6aecadbce8c00a6e705ac349cad",
  ],
  "embedding.f16": ["sha256", "07163e5f6f8a68f9ffeed7a8ff770c68098c2db216232321912188bd614b9a72"],
  "encoder.onnx": ["sha256", "ac316927d8b4d726932ea876617447847a57e35b2053db6b42db6868a91f8f05"],
  "encoder.onnx.data": [
    "sha256",
    "3338df284d31ba23e94ef8f0c397e7fa69a36dc634b4569a4739f94d72a38228",
  ],
  "meta.json": ["sha256", "2fb6b111dcf4f2477d7ff7699b2374c5f7194ae5fa20ef2a06f121c243119a37"],
  "vocab.json": ["sha256", "3eb2f73e8853dce5156c2ed97c0b1bb84eb4ebd201eb1761d15977fc1ea31490"],
};

export function verifyVozFile(name, bytes) {
  const expected = VOZ_FILES[name];
  if (!expected) throw new Error(`Unexpected Voz model file: ${name}`);
  const [algorithm, digestExpected] = expected;
  const hash = createHash(algorithm);
  hash.update(bytes);
  const digest = hash.digest("hex");
  if (digest !== digestExpected) {
    throw new Error(`Voz model integrity check failed: ${name}`);
  }
}

async function verifyFile(name, file) {
  const expected = VOZ_FILES[name];
  const [algorithm, digestExpected] = expected;
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const digest = hash.digest("hex");
  if (digest !== digestExpected) await unlink(file);
}

export async function removeInvalidVozCache() {
  const root =
    process.env.DAL_CACHE_ROOT ??
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches")
      : (process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")));
  const dir = path.join(root, "desert-ant-models", ...VOZ_REPO.split("/"), VOZ_REVISION, "web");
  await Promise.all(
    Object.keys(VOZ_FILES).map(async (name) => {
      try {
        await verifyFile(name, path.join(dir, name));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }),
  );
}

function vozModelName(url) {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://huggingface.co" ||
    !parsed.pathname.startsWith(VOZ_PREFIX) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Unexpected Voz model URL: ${url}`);
  }
  const name = decodeURIComponent(parsed.pathname.slice(VOZ_PREFIX.length));
  if (name.includes("/") || !Object.hasOwn(VOZ_FILES, name)) {
    throw new Error(`Unexpected Voz model file: ${name}`);
  }
  return name;
}

export function verifyVozResponse(url, bytes) {
  const name = vozModelName(url);
  verifyVozFile(name, bytes);
}

function isVozModelRequest(url) {
  return (
    url.pathname.includes("/desert-ant-labs/voz/") ||
    (url.pathname.includes("/resolve/") && url.pathname.includes("/web/"))
  );
}

function isVozLicenseRequest(url, method) {
  // Voz's WASI core posts only the grant and activation paths from its API base.
  return (
    url.origin === "https://events.desertant.com" &&
    !url.username &&
    !url.password &&
    ["/api/v1/license", "/api/v1/activate"].includes(url.pathname) &&
    !url.search &&
    !url.hash &&
    method.toUpperCase() === "POST"
  );
}

function allowedHubRedirect(responseUrl) {
  if (!responseUrl) return false;
  const host = new URL(responseUrl).hostname;
  return (
    host === "huggingface.co" ||
    host === "cas-bridge.xethub.hf.co" ||
    /^(?:us|eu|ap|sa|me|af)\.aws\.cdn\.hf\.co$/.test(host) ||
    host === "cdn-lfs.huggingface.co" ||
    /^cdn-lfs-(?:us|eu)-\d+\.hf\.co$/.test(host)
  );
}

export function createVozFetch(fetchImpl) {
  return async (...args) => {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    const parsed = new URL(url, "https://invalid.local");
    const method = args[1]?.method ?? (args[0] instanceof Request ? args[0].method : "GET");
    if (isVozLicenseRequest(parsed, method)) {
      const init = { ...args[1], redirect: "error" };
      const response = await fetchImpl(args[0], init);
      if (response.url !== parsed.href || !isVozLicenseRequest(new URL(response.url), method)) {
        throw new Error(`Unexpected Voz license redirect: ${response.url}`);
      }
      return response;
    }
    if (!isVozModelRequest(parsed)) throw new Error(`Unexpected Voz external request: ${url}`);
    if (method.toUpperCase() !== "GET") throw new Error(`Unexpected Voz model method: ${method}`);
    const name = vozModelName(url);
    let current = parsed;
    const headers = new Headers(
      args[1]?.headers ?? (args[0] instanceof Request ? args[0].headers : undefined),
    );
    const visited = new Set([current.href]);
    let response;
    for (let hop = 0; hop <= 10; hop++) {
      const request =
        args[0] instanceof Request ? new Request(current.href, args[0]) : current.href;
      response = await fetchImpl(request, { ...args[1], headers, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Unexpected Voz model redirect: missing location");
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error("Unexpected Voz model redirect: invalid location");
      }
      if (
        next.protocol !== "https:" ||
        next.username ||
        next.password ||
        next.hash ||
        !allowedHubRedirect(next.href) ||
        visited.has(next.href) ||
        hop === 10
      )
        throw new Error(`Unexpected Voz model redirect: ${next.href}`);
      if (next.origin !== current.origin) {
        for (const header of ["authorization", "cookie", "proxy-authorization"])
          headers.delete(header);
      }
      visited.add(next.href);
      current = next;
    }
    if (response.url && response.url !== current.href)
      throw new Error(`Unexpected Voz model redirect: ${response.url}`);
    if (!response.ok) throw new Error(`voz: model fetch -> HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    verifyVozFile(name, new Uint8Array(bytes));
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
