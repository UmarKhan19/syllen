import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { resolveNotices, writeNotices } from "./sidecar-notices.mjs";

test("resolves raw notices from exact upstream version tags", async () => {
  const urls = [];
  const files = await resolveNotices("25.8.2", "1.31.1", async (url) => {
    urls.push(url);
    return new Response(new TextEncoder().encode(url));
  });
  assert.deepEqual(urls, [
    "https://raw.githubusercontent.com/nodejs/node/v25.8.2/LICENSE",
    "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.31.1/LICENSE",
    "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.31.1/ThirdPartyNotices.txt",
  ]);
  assert.equal(files.length, 3);
  assert.ok(files.every(({ content }) => content.length));
});

test("fails closed when an exact-version notice is unavailable", async () => {
  await assert.rejects(
    resolveNotices("25.8.2", "1.31.1", async () => new Response("missing", { status: 404 })),
    /HTTP 404/,
  );
});

test("rejects versions that could not identify an exact upstream tag", async () => {
  await assert.rejects(resolveNotices("latest", "1.31.1", async () => assert.fail()));
});

test("collects locked npm and Rust notices plus app documents and fonts", async () => {
  const root = await mkdtemp(join(tmpdir(), "syllen-notices-fixture-"));
  const directory = join(root, "out");
  const write = async (path, text) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  };
  try {
    await write("LICENSE", "app license bytes");
    await write("THIRD_PARTY_NOTICES.md", "app notice bytes");
    await write("public/fonts/test-OFL.txt", "font OFL bytes");
    await write("package.json", JSON.stringify({ dependencies: {
      "fixture-ui": "1.0.0", "fixture-dal": "1.0.0",
    } }));
    await write("package-lock.json", JSON.stringify({ packages: {
      "node_modules/fixture-ui": { version: "1.0.0", resolved: "https://npm.test/fixture-ui.tgz" },
      "node_modules/fixture-dal": { version: "1.0.0", resolved: "https://npm.test/fixture-dal.tgz" },
    } }));
    await write("node_modules/fixture-ui/package.json", JSON.stringify({
      name: "fixture-ui", version: "1.0.0", license: "Apache-2.0", dependencies: {},
    }));
    await write("node_modules/fixture-ui/NOTICE.txt", "npm notice bytes");
    await write("node_modules/fixture-dal/package.json", JSON.stringify({
      name: "fixture-dal", version: "1.0.0", license: "SEE LICENSE IN LICENSE.md", dependencies: {},
    }));
    await write("node_modules/fixture-dal/LICENSE.md", "DAL license pointer bytes");
    await write("src-tauri/sidecar/package.json", JSON.stringify({ dependencies: {} }));
    await write("src-tauri/sidecar/package-lock.json", JSON.stringify({ packages: {} }));
    await write("src-tauri/Cargo.toml", "[package]\nname='fixture'\n");
    await write("src-tauri/crates/cssparser/Cargo.toml", "[package]\nname='cssparser'\nversion='0.37.0'\n");
    await write("src-tauri/crates/cssparser/LICENSE", "crate license bytes");
    await write("src-tauri/crates/noticecrate/Cargo.toml", "[package]\nname='noticecrate'\nversion='1.2.3'\n");
    await write("src-tauri/crates/noticecrate/COPYRIGHT", "crate copyright bytes");
    await write("src-tauri/crates/noticecrate/NOTICE.txt", "crate notice bytes");
    const rootId = "path+file:///fixture#fixture@0.1.0";
    const crateId = "registry+https://github.com/rust-lang/crates.io-index#cssparser@0.37.0";
    const noticeCrateId = "registry+https://github.com/rust-lang/crates.io-index#noticecrate@1.2.3";
    const buildCrateId = "registry+https://github.com/rust-lang/crates.io-index#build-only@1.0.0";
    const metadata = {
      resolve: {
        root: rootId,
        nodes: [
          { id: rootId, deps: [
            { pkg: crateId, dep_kinds: [{ kind: null }] },
            { pkg: noticeCrateId, dep_kinds: [{ kind: null }] },
            { pkg: buildCrateId, dep_kinds: [{ kind: "build" }] },
          ] },
          { id: crateId, deps: [] },
          { id: noticeCrateId, deps: [] },
          { id: buildCrateId, deps: [] },
        ],
      },
      packages: [
        { id: rootId, name: "fixture", version: "0.1.0", manifest_path: join(root, "src-tauri/Cargo.toml") },
        {
          id: crateId, name: "cssparser", version: "0.37.0", license: "MPL-2.0",
          authors: ["Fixture Author <private@example.invalid>"],
          manifest_path: join(root, "src-tauri/crates/cssparser/Cargo.toml"),
          repository: "https://github.com/servo/rust-cssparser",
        },
        {
          id: noticeCrateId, name: "noticecrate", version: "1.2.3", license: "MIT",
          manifest_path: join(root, "src-tauri/crates/noticecrate/Cargo.toml"),
        },
        {
          id: buildCrateId, name: "build-only", version: "1.0.0",
          manifest_path: join(root, "src-tauri/crates/build-only/Cargo.toml"),
        },
      ],
    };
    const requestedUrls = [];
    await writeNotices(directory, "22.14.0", "1.31.1", {
      root,
      target: "x86_64-unknown-linux-gnu",
      metadata,
      fetchImpl: async (url) => {
        requestedUrls.push(url);
        return new Response(new TextEncoder().encode(`raw:${url}`));
      },
    });
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    assert.equal(manifest.nodeVersion, "22.14.0");
    assert.equal(manifest.onnxruntimeNodeVersion, "1.31.1");
    assert.equal(manifest.rustPackages.length, 2);
    assert.equal(manifest.npmPackages.length, 2);
    assert.ok(manifest.rustPackages[0].licenseFiles.includes("rust/cssparser@0.37.0/LICENSE"));
    assert.deepEqual(manifest.rustPackages[0].authors, ["Fixture Author"]);
    assert.ok(manifest.files.some(({ path }) => path === "LICENSE"));
    assert.ok(manifest.files.some(({ path }) => path === "THIRD_PARTY_NOTICES.md"));
    assert.ok(manifest.files.some(({ path }) => path === "fonts/test-OFL.txt"));
    assert.ok(manifest.files.some(({ path }) => path === "spdx/Apache-2.0.txt"));
    assert.match(await readFile(join(directory, "rust/MPL-2.0-SOURCE-LINKS.txt"), "utf8"),
      /cssparser@0\.37\.0 \| authors:.*source: https:\/\/crates\.io\/api\/v1\/crates\/cssparser\/0\.37\.0\/download/);
    assert.equal((await readFile(join(directory, "LICENSE"), "utf8")), "app license bytes");
    assert.equal((await readFile(join(directory, "THIRD_PARTY_NOTICES.md"), "utf8")), "app notice bytes");
    assert.equal((await readFile(join(directory, "fonts/test-OFL.txt"), "utf8")), "font OFL bytes");
    assert.equal((await readFile(join(directory, "rust/cssparser@0.37.0/LICENSE"), "utf8")), "crate license bytes");
    assert.equal((await readFile(join(directory, "npm/frontend/fixture-ui@1.0.0/NOTICE.txt"), "utf8")), "npm notice bytes");
    assert.ok(manifest.npmPackages.find(({ name }) => name === "fixture-ui").licenseFiles.includes("spdx/Apache-2.0.txt"));
    assert.equal((await readFile(join(directory, "npm/frontend/fixture-dal@1.0.0/LICENSE.md"), "utf8")), "DAL license pointer bytes");
    assert.ok(!requestedUrls.some((url) => url.includes("LicenseRef-DAL")));
    const noticeCrate = manifest.rustPackages.find(({ name }) => name === "noticecrate");
    assert.ok(noticeCrate.licenseFiles.includes("rust/noticecrate@1.2.3/COPYRIGHT"));
    assert.ok(noticeCrate.licenseFiles.includes("rust/noticecrate@1.2.3/NOTICE.txt"));
    assert.ok(noticeCrate.licenseFiles.includes("spdx/MIT.txt"));
    assert.equal((await readFile(join(directory, "rust/noticecrate@1.2.3/COPYRIGHT"), "utf8")), "crate copyright bytes");
    assert.equal((await readFile(join(directory, "rust/noticecrate@1.2.3/NOTICE.txt"), "utf8")), "crate notice bytes");
    const spdxUrl = "https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/Apache-2.0.txt";
    assert.equal((await readFile(join(directory, "spdx/Apache-2.0.txt"), "utf8")), `raw:${spdxUrl}`);
    assert.equal(manifest.files.find(({ path }) => path === "spdx/Apache-2.0.txt").source, spdxUrl);
    const mitUrl = "https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/MIT.txt";
    assert.equal((await readFile(join(directory, "spdx/MIT.txt"), "utf8")), `raw:${mitUrl}`);
    assert.equal(manifest.files.find(({ path }) => path === "spdx/MIT.txt").source, mitUrl);
    assert.doesNotMatch(JSON.stringify(manifest), /\/home\/|private@example\.invalid/);
    for (const { path, source, sha256 } of manifest.files) {
      assert.ok(!path.startsWith("/") && !path.split("/").includes(".."));
      const bytes = await readFile(join(directory, path));
      assert.ok(source);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
    }
    const invalidMetadata = structuredClone(metadata);
    delete invalidMetadata.packages[1].license;
    await assert.rejects(
      writeNotices(directory, "22.14.0", "1.31.1", {
        root,
        target: "x86_64-unknown-linux-gnu",
        metadata: invalidMetadata,
        fetchImpl: async (url) => new Response(new TextEncoder().encode(`raw:${url}`)),
      }),
      /has no license metadata/,
    );
    const escapingMetadata = structuredClone(metadata);
    escapingMetadata.packages[1].license_file = "../../LICENSE";
    await assert.rejects(
      writeNotices(directory, "22.14.0", "1.31.1", {
        root,
        target: "x86_64-unknown-linux-gnu",
        metadata: escapingMetadata,
        fetchImpl: async (url) => new Response(new TextEncoder().encode(`raw:${url}`)),
      }),
      /license file escapes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
