// Copies the current Node binary into the sidecar and prunes ONNX Runtime to
// this platform, so `tauri build` bundles a runnable, smaller runtime.
import {
  chmodSync,
  cpSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeNotices } from "./sidecar-notices.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sidecar = join(root, "src-tauri", "sidecar");
const modules = join(sidecar, "node_modules");

if (!existsSync(join(modules, "@desert-ant-labs", "voz"))) {
  console.error("Install the sidecar first: npm run sidecar:install");
  process.exit(1);
}

const onnxPackage = JSON.parse(
  readFileSync(join(modules, "onnxruntime-node", "package.json"), "utf8"),
);
await writeNotices(join(sidecar, "notices"), process.versions.node, onnxPackage.version, { root });

const nodeName = process.platform === "win32" ? "node.exe" : "node";
const nodeTarget = join(sidecar, nodeName);
if (process.execPath !== nodeTarget) {
  cpSync(process.execPath, nodeTarget);
  if (process.platform !== "win32") chmodSync(nodeTarget, 0o755);
}
rmSync(join(modules, ".bin"), { recursive: true, force: true });
console.log(`node: ${(statSync(nodeTarget).size / 1e6).toFixed(0)} MB -> ${nodeTarget}`);

const os = { linux: "linux", darwin: "darwin", win32: "win32" }[process.platform];
const arch = process.arch === "x64" ? "x64" : process.arch;
const binRoot = join(modules, "onnxruntime-node", "bin");

if (!os || !existsSync(binRoot)) {
  console.warn("onnxruntime-node/bin not found, nothing to prune");
  process.exit(0);
}

for (const napiDir of readdirSync(binRoot)) {
  const napiPath = join(binRoot, napiDir);
  for (const targetOs of readdirSync(napiPath)) {
    for (const targetArch of readdirSync(join(napiPath, targetOs))) {
      if (targetOs !== os || targetArch !== arch) {
        rmSync(join(napiPath, targetOs, targetArch), { recursive: true, force: true });
      }
    }
    if (readdirSync(join(napiPath, targetOs)).length === 0) {
      rmSync(join(napiPath, targetOs), { recursive: true, force: true });
    }
  }
}
console.log(`onnxruntime-node: kept ${os}/${arch}`);
