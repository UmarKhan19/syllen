import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os, { devNull } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isMediaArtifactPath } from "./media-extensions.mjs";

const root = process.cwd();
const run = (command, args, options = {}) =>
  spawnSync(command, args, { cwd: root, maxBuffer: 16 * 1024 * 1024, ...options });
const output = (result) => `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`;
function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const check = run("git", ["diff", "--cached", "--check"]);
if (check.status !== 0) fail(output(check));
const listing = run("git", ["ls-files", "--cached", "-z"]);
if (listing.status !== 0) {
  fail(output(listing) || "Could not list the Git index.");
  process.exit();
}
const files = listing.stdout.toString().split("\0").filter(Boolean);
const changedListing = run("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"]);
if (changedListing.status !== 0) {
  fail(output(changedListing) || "Could not list staged changes.");
  process.exit();
}
const changed = new Set(changedListing.stdout.toString().split("\0").filter(Boolean));
const snapshot = await mkdtemp(path.join(os.tmpdir(), "syllen-staged-"));
const scanDir = path.join(snapshot, "gitleaks-input");
await mkdir(scanDir);
try {
  for (const file of files) {
    const staged = run("git", ["show", `:${file}`]);
    if (staged.status !== 0) {
      fail(`Could not read staged blob for ${JSON.stringify(file)}.`);
      continue;
    }
    const target = path.resolve(snapshot, file);
    if (!target.startsWith(`${snapshot}${path.sep}`)) {
      fail(`Invalid staged path: ${JSON.stringify(file)}`);
      continue;
    }
    const lower = file.toLowerCase();
    const dataPath =
      /^(jobs|library)\//.test(lower) || /(^|\/)library\.db(?:-(?:wal|shm))?$/.test(lower);
    const artifact =
      isMediaArtifactPath(file) ||
      /\.(?:onnx|pt|pth|safetensors|gguf|tflite|bin|sqlite3?)$/i.test(file) ||
      /(^|\/)(?:target|dist|node_modules|coverage|build|\.vite)\//.test(file);
    const syntheticFixture = /(^|\/)(?:test|tests)\/fixtures\/synthetic(?:\/|$)/i.test(file);
    const fixtureAllowed = syntheticFixture && staged.stdout.length <= 1024 * 1024;
    if (changed.has(file) && (dataPath || artifact) && !fixtureAllowed) {
      fail(`Refusing staged app data or generated artifact: ${JSON.stringify(file)}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, staged.stdout, { mode: 0o600 });
    if (changed.has(file)) {
      const scanPath = file.replace(
        /(^|\/)(\.gitleaksignore|\.gitleaks\.toml|\.gitattributes)$/,
        "$1.staged-policy-$2.txt",
      );
      const scanTarget = path.resolve(scanDir, scanPath);
      if (!scanTarget.startsWith(`${scanDir}${path.sep}`)) {
        fail(`Invalid staged scan path: ${JSON.stringify(file)}`);
        continue;
      }
      await mkdir(path.dirname(scanTarget), { recursive: true });
      await writeFile(scanTarget, staged.stdout, { mode: 0o600 });
    }
  }

  const scanner = run("gitleaks", ["version"]);
  const version = /^v?(\d+)\.(\d+)\.(\d+)/m.exec(scanner.stdout?.toString() ?? "");
  const [major, minor, patch] = version?.slice(1).map(Number) ?? [];
  const supported = major > 8 || (major === 8 && (minor > 30 || (minor === 30 && patch >= 1)));
  if (scanner.status !== 0 || !supported) {
    fail(
      "Gitleaks is required for commits. Install Gitleaks v8.30.1 or newer and put `gitleaks` on PATH; see CONTRIBUTING.md.",
    );
  } else {
    const trustedConfig = path.join(snapshot, "gitleaks-default.toml");
    await writeFile(trustedConfig, "[extend]\nuseDefault = true\n", { mode: 0o600 });
    const { GITLEAKS_CONFIG: _config, GITLEAKS_CONFIG_TOML: _configToml, ...safeEnv } = process.env;
    const scan = run(
      "gitleaks",
      [
        "dir",
        scanDir,
        "--redact",
        "--no-banner",
        "--gitleaks-ignore-path",
        devNull,
        "--config",
        trustedConfig,
        "--report-format",
        "json",
        "--report-path",
        devNull,
      ],
      {
        cwd: scanDir,
        env: safeEnv,
      },
    );
    if (scan.status !== 0)
      fail(
        "Gitleaks found a staged secret or failed to scan. Review staged files locally; scanner output is suppressed to avoid exposing secret values.",
      );
  }

  const biome = path.join(root, "node_modules", ".bin", "biome");
  const frontendFiles = [...changed].filter((file) =>
    /^(src\/|scripts\/.*\.mjs$|vite\.config\.ts$|index\.html$|package\.json$|src-tauri\/sidecar\/(?:package\.json|server\.mjs)$|biome\.json$)/.test(
      file,
    ),
  );
  if (frontendFiles.length) {
    for (const check of ["format", "lint"]) {
      const args = [check, "--no-errors-on-unmatched", "--files-ignore-unknown=true"];
      if (check === "lint") args.push("--error-on-warnings");
      const result = run(biome, [...args, ...frontendFiles], { cwd: snapshot });
      if (result.status !== 0) fail(output(result));
    }
  }
  if (
    [...changed].some(
      (file) => file.endsWith(".rs") || /(^|\/)rustfmt\.toml$|(^|\/)\.rustfmt\.toml$/.test(file),
    )
  ) {
    const fmt = run("cargo", ["fmt", "--all", "--", "--check"], {
      cwd: path.join(snapshot, "src-tauri"),
    });
    if (fmt.status !== 0) fail(`Staged Rust formatting check failed.\n${output(fmt)}`);
  }
} finally {
  await rm(snapshot, { recursive: true, force: true });
}
