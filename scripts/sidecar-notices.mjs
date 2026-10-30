import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const spdxTag = "v3.27.0";
const spdxUrl = (id) =>
  `https://raw.githubusercontent.com/spdx/license-list-data/${spdxTag}/text/${id}.txt`;
const noticePattern = /^(license|licence|copying|notice|copyright|patents|authors|credits|contributors)(?:[._ -]|$)/i;
const licenseTextPattern = /^(license|licence|copying)(?:[._ -]|$)/i;

const assets = (nodeVersion, onnxVersion) => [
  [
    `node-v${nodeVersion}-LICENSE.txt`,
    `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`,
  ],
  [
    `onnxruntime-node-v${onnxVersion}-LICENSE.txt`,
    `https://raw.githubusercontent.com/microsoft/onnxruntime/v${onnxVersion}/LICENSE`,
  ],
  [
    `onnxruntime-node-v${onnxVersion}-ThirdPartyNotices.txt`,
    `https://raw.githubusercontent.com/microsoft/onnxruntime/v${onnxVersion}/ThirdPartyNotices.txt`,
  ],
];

async function fetchBytes(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Could not fetch required notice ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error(`Required notice is empty: ${url}`);
  return bytes;
}

export async function resolveNotices(nodeVersion, onnxVersion, fetchImpl = fetch) {
  for (const version of [nodeVersion, onnxVersion]) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`Invalid runtime version for notice lookup: ${version}`);
    }
  }
  const files = [];
  for (const [name, url] of assets(nodeVersion, onnxVersion)) {
    files.push({ name, url, content: await fetchBytes(url, fetchImpl) });
  }
  return files;
}

function licenseIds(expression) {
  if (!expression || /^SEE LICENSE IN\b/i.test(expression)) return [];
  return [...new Set(
    expression
      .replaceAll("/", " OR ")
      .match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g)
      ?.filter((id) => !["AND", "OR", "WITH"].includes(id)) ?? [],
  )];
}

async function findNoticeFiles(directory, path = "") {
  const files = [];
  for (const entry of await readdir(join(directory, path), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "node_modules") {
      files.push(...(await findNoticeFiles(directory, join(path, entry.name))));
    } else if (entry.isFile() && noticePattern.test(entry.name)) {
      files.push(join(path, entry.name));
    }
  }
  return files.sort();
}

function packageDirectory(from, name) {
  for (let current = from; ; current = dirname(current)) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return resolve(candidate);
    if (current === dirname(current)) break;
  }
  throw new Error(`Could not resolve installed package ${name} from ${from}`);
}

async function collectNpm(root, project, label, addFile, getLicenseText) {
  const lock = JSON.parse(await readFile(join(project, "package-lock.json"), "utf8"));
  const rootPackage = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  const packages = new Map();
  const visited = new Set();

  async function visit(from, name, optional = false) {
    let directory;
    try {
      directory = packageDirectory(from, name);
    } catch (error) {
      if (optional) return;
      throw error;
    }
    if (visited.has(directory)) return;
    const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    const lockPath = relative(project, directory).split(sep).join("/");
    const locked = lock.packages?.[lockPath];
    if (!locked || locked.version !== pkg.version) {
      if (optional && lockPath.startsWith("../")) return;
      throw new Error(`Installed ${pkg.name}@${pkg.version} does not match ${label} lock entry ${lockPath}`);
    }
    visited.add(directory);

    const source = locked.resolved ?? pkg.repository?.url ?? "";
    const packageRecord = {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "",
      source,
      licenseFiles: [],
    };
    packages.set(`${pkg.name}@${pkg.version}`, packageRecord);

    const files = await findNoticeFiles(directory);
    const declaredLicense = pkg.license?.match(/^SEE LICENSE IN\s+(.+)$/i)?.[1];
    const hasLicenseText = files.some((file) =>
      licenseTextPattern.test(basename(file)) && !file.toLowerCase().endsWith(".spdx"),
    ) || (declaredLicense && files.some(
      (file) => file.split(sep).join("/") === declaredLicense.replaceAll("\\", "/"),
    ));
    for (const file of files) {
      const output = `npm/${label}/${pkg.name}@${pkg.version}/${file}`;
      await addFile(output, await readFile(join(directory, file)), `${source}#${file}`);
      packageRecord.licenseFiles.push(output);
    }
    if (!hasLicenseText) {
      const ids = licenseIds(pkg.license);
      if (!ids.length) throw new Error(`No license text or SPDX license for ${pkg.name}@${pkg.version}`);
      for (const id of ids) packageRecord.licenseFiles.push(await getLicenseText(id));
    }
    if (!files.length && !packageRecord.licenseFiles.length) {
      throw new Error(`No license or notice files found for ${pkg.name}@${pkg.version}`);
    }

    for (const dependency of Object.keys(pkg.dependencies ?? {})) await visit(directory, dependency);
    for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) {
      await visit(directory, dependency, true);
    }
    for (const dependency of Object.keys(pkg.peerDependencies ?? {})) {
      await visit(directory, dependency, true);
    }
  }

  for (const dependency of Object.keys(rootPackage.dependencies ?? {})) await visit(project, dependency);
  for (const dependency of Object.keys(rootPackage.optionalDependencies ?? {})) {
    await visit(project, dependency, true);
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function cargoMetadata(root) {
  const target = process.env.TAURI_ENV_TARGET_TRIPLE ?? process.env.CARGO_BUILD_TARGET ??
    execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
  if (!target) throw new Error("Could not determine Rust target for license metadata");
  const json = execFileSync(
    "cargo",
    ["metadata", "--locked", "--format-version", "1", "--filter-platform", target, "--manifest-path", join(root, "src-tauri", "Cargo.toml")],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  );
  return { metadata: JSON.parse(json), target };
}

function crateSourceUrl(pkg) {
  return `https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/download`;
}

async function collectCargo(root, metadata, target, addFile, getLicenseText) {
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const visited = new Set();
  const packages = [];
  const rootNode = nodes.get(metadata.resolve.root);
  if (!rootNode) throw new Error("Cargo metadata has no root package node");

  async function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const node = nodes.get(id);
    const pkg = packagesById.get(id);
    if (!node || !pkg) throw new Error(`Cargo metadata references missing package ${id}`);
    if (id !== metadata.resolve.root) {
      if (!pkg.license && !pkg.license_file) throw new Error(`Cargo package ${pkg.name}@${pkg.version} has no license metadata`);
      const directory = dirname(pkg.manifest_path);
      const files = await findNoticeFiles(directory);
      if (pkg.license_file) {
        const declared = resolve(directory, pkg.license_file);
        const relativePath = relative(directory, declared);
        if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
          throw new Error(`Cargo license file escapes ${pkg.name}@${pkg.version}`);
        }
        if (!files.includes(relativePath)) files.push(relativePath);
      }
      const hasLicenseText = files.some((file) =>
        licenseTextPattern.test(basename(file)) && !file.toLowerCase().endsWith(".spdx"),
      ) || Boolean(pkg.license_file);
      const source = crateSourceUrl(pkg);
      const record = {
        name: pkg.name,
        version: pkg.version,
        authors: (pkg.authors ?? []).map((author) => author.replace(/\s*<[^>]+>/, "")),
        license: pkg.license ?? `SEE LICENSE IN ${pkg.license_file}`,
        source,
        licenseFiles: [],
      };
      packages.push(record);
      for (const file of files) {
        const output = `rust/${pkg.name}@${pkg.version}/${file}`;
        await addFile(output, await readFile(join(directory, file)), `${source}#${file}`);
        record.licenseFiles.push(output);
      }
      if (!hasLicenseText) {
        const ids = licenseIds(pkg.license);
        if (!ids.length) throw new Error(`No license text available for ${pkg.name}@${pkg.version} (${pkg.license})`);
        for (const license of ids) record.licenseFiles.push(await getLicenseText(license));
      }
    }
    for (const dependency of node.deps) {
      if (dependency.dep_kinds.some((kind) => kind.kind === null)) await visit(dependency.pkg);
    }
  }
  await visit(metadata.resolve.root);
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  const mpl = packages.filter((pkg) => /(?:^|\W)MPL-2\.0(?:$|\W)/.test(pkg.license));
  const sourceList = [
    "Mozilla Public License 2.0 source packages",
    "Each crates.io link provides the unmodified, exact-version source archive.",
    ...mpl.map((pkg) => `${pkg.name}@${pkg.version} | authors: ${pkg.authors.join(", ")} | source: ${pkg.source}`),
    "Full MPL-2.0 text: ../spdx/MPL-2.0.txt",
    "",
  ].join("\n");
  await addFile("rust/MPL-2.0-SOURCE-LINKS.txt", Buffer.from(sourceList), "generated from Cargo metadata and crates.io");
  await addFile("rust/CARGO-DEPENDENCIES.json", Buffer.from(`${JSON.stringify({ target, packages }, null, 2)}\n`), "generated from locked cargo metadata");
  return { target, packages };
}

async function removePreviousFiles(directory) {
  let previous;
  try {
    previous = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  } catch {
    return;
  }
  for (const file of previous.files ?? []) {
    const name = file.path ?? file.name;
    if (typeof name !== "string") continue;
    const path = resolve(directory, name);
    if (!path.startsWith(`${resolve(directory)}${sep}`)) continue;
    await rm(path, { force: true });
  }
}

export async function writeNotices(directory, nodeVersion, onnxVersion, {
  root,
  fetchImpl = fetch,
  metadata,
  target,
} = {}) {
  const runtimeFiles = await resolveNotices(nodeVersion, onnxVersion, fetchImpl);
  const records = [];
  const licenseCache = new Map();
  const addFile = async (path, content, source) => {
    const destination = resolve(directory, path);
    if (!destination.startsWith(`${resolve(directory)}${sep}`)) {
      throw new Error(`Notice output path escapes destination: ${path}`);
    }
    content = Buffer.from(content);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
    records.push({
      path,
      source,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  };
  const getLicenseText = async (id) => {
    if (!/^[A-Za-z0-9.-]+$/.test(id)) throw new Error(`Cannot resolve non-SPDX license identifier ${id}`);
    if (licenseCache.has(id)) return licenseCache.get(id);
    const path = `spdx/${id}.txt`;
    await addFile(path, await fetchBytes(spdxUrl(id), fetchImpl), spdxUrl(id));
    licenseCache.set(id, path);
    return path;
  };

  if (!root) throw new Error("Project root is required to collect distribution notices");
  await mkdir(directory, { recursive: true });
  await removePreviousFiles(directory);
  for (const file of runtimeFiles) {
    await addFile(file.name, file.content, file.url);
  }

  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    await addFile(name, await readFile(join(root, name)), `Syllen repository: ${name}`);
  }
  for (const name of (await readdir(join(root, "public", "fonts"))).sort()) {
    if (/OFL/i.test(name)) {
      await addFile(
        `fonts/${name}`,
        await readFile(join(root, "public", "fonts", name)),
        `Syllen repository: public/fonts/${name}`,
      );
    }
  }

  const npmPackages = [];
  npmPackages.push(...await collectNpm(root, root, "frontend", addFile, getLicenseText));
  npmPackages.push(...await collectNpm(root, join(root, "src-tauri", "sidecar"), "sidecar", addFile, getLicenseText));
  const cargo = metadata ? { metadata, target } : cargoMetadata(root);
  const rust = await collectCargo(root, cargo.metadata, cargo.target, addFile, getLicenseText);

  const manifest = {
    nodeVersion,
    onnxruntimeNodeVersion: onnxVersion,
    rustTarget: rust.target,
    npmPackages: npmPackages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
    rustPackages: rust.packages,
    files: records.sort((a, b) => a.path.localeCompare(b.path)),
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
