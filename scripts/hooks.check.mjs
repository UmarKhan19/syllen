import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isMediaArtifactPath, MEDIA_EXTENSIONS } from "./media-extensions.mjs";

const runner = fileURLToPath(new URL("./pre-commit-checks.mjs", import.meta.url));
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localEnvResult = spawnSync("git", ["rev-parse", "--local-env-vars"], {
  cwd: project,
  encoding: "utf8",
});
if (localEnvResult.status !== 0)
  throw new Error("Could not get Git's local environment variable names.");
const localEnvNames = localEnvResult.stdout.trim().split(/\r?\n/).filter(Boolean);

// Git's hook-local environment can redirect foreign-repo commands into its caller.
function isolatedEnv(inherited = process.env, deliberateOverrides = {}) {
  const env = { ...inherited };
  for (const name of localEnvNames) delete env[name];
  return { ...env, ...deliberateOverrides };
}

const cleanTestEnv = isolatedEnv();

function runGit(cwd, args, inheritedEnv = cleanTestEnv, deliberateOverrides = {}) {
  return spawnSync("git", args, {
    cwd,
    env: isolatedEnv(inheritedEnv, deliberateOverrides),
    encoding: "utf8",
  });
}

const git = (cwd, ...args) => runGit(cwd, args);
const runPrecommit = (cwd, deliberateOverrides = {}) =>
  spawnSync(process.execPath, ["pre-commit-checks.mjs"], {
    cwd,
    env: { ...cleanTestEnv, ...deliberateOverrides },
    encoding: "utf8",
  });

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "syllen-hook-test-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "hook-test@example.invalid");
  git(dir, "config", "user.name", "Hook Test");
  await writeFile(path.join(dir, "pre-commit-checks.mjs"), await readFile(runner));
  await writeFile(
    path.join(dir, "media-extensions.mjs"),
    await readFile(new URL("./media-extensions.mjs", import.meta.url)),
  );
  return dir;
}

async function scanner(dir, script = "exit 0") {
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "gitleaks"),
    `#!/bin/sh\nif [ "$1" = version ]; then echo 8.30.1; exit 0; fi\n${script}\n`,
    { mode: 0o755 },
  );
  return `${bin}:${cleanTestEnv.PATH}`;
}

test("checks index bytes for an initial commit without changing staged or unstaged content", async () => {
  const dir = await setup();
  try {
    const envPath = await scanner(dir, 'test "$(cat "$2/- spaced.txt")" = staged');
    const file = path.join(dir, "- spaced.txt");
    await writeFile(file, "staged");
    assert.equal(git(dir, "add", "--", "- spaced.txt").status, 0);
    await writeFile(file, "unstaged");
    const index = git(dir, "write-tree").stdout.trim();
    const result = runPrecommit(dir, { PATH: envPath });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(dir, "write-tree").stdout.trim(), index);
    assert.equal(await readFile(file, "utf8"), "unstaged");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checks staged frontend bytes rather than the working-tree version", async () => {
  const dir = await setup();
  try {
    const envPath = await scanner(dir);
    const biome = path.join(dir, "node_modules", ".bin");
    await mkdir(biome, { recursive: true });
    await writeFile(
      path.join(biome, "biome"),
      '#!/bin/sh\ntest "$(cat "$PWD/src/check.ts")" = "export const staged = true;" || exit 12\n',
      { mode: 0o755 },
    );
    await mkdir(path.join(dir, "src"));
    const file = path.join(dir, "src", "check.ts");
    await writeFile(file, "export const staged = true;\n");
    assert.equal(git(dir, "add", "--", "src/check.ts").status, 0);
    await writeFile(file, "export const staged = false;\n");
    const result = runPrecommit(dir, { PATH: envPath });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(file, "utf8"), "export const staged = false;\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isolates a staged blob from a live gitleaksignore after worktree deletion", async () => {
  const dir = await setup();
  try {
    await writeFile(path.join(dir, "keep.txt"), "present");
    assert.equal(git(dir, "add", "--", "keep.txt").status, 0);
    assert.equal(git(dir, "commit", "-qm", "base").status, 0);
    await writeFile(path.join(dir, "keep.txt"), "secret-staged");
    assert.equal(git(dir, "add", "--", "keep.txt").status, 0);
    await writeFile(path.join(dir, "keep.txt"), "working-tree deletion follows");
    await rm(path.join(dir, "keep.txt"));
    await writeFile(path.join(dir, ".gitleaksignore"), "keep.txt:generic-api-key:1\n");
    await writeFile(path.join(dir, ".gitleaks.toml"), '[allowlist]\npaths = [".*"]\n');
    const envPath = await scanner(
      dir,
      'test "$(cat "$2/keep.txt")" = secret-staged || exit 8; test ! -e "$2/.gitleaksignore" || exit 7; test ! -e "$2/.gitleaks.toml" || exit 6; exit 9',
    );
    const result = runPrecommit(dir, { PATH: envPath });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /secret-staged/);
    assert.equal(git(dir, "show", ":keep.txt").stdout, "secret-staged");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isolates a staged blob from live gitattributes diff suppression", async () => {
  const dir = await setup();
  try {
    await writeFile(path.join(dir, "secret.txt"), "staged-secret-marker");
    assert.equal(git(dir, "add", "--", "secret.txt").status, 0);
    await writeFile(path.join(dir, "secret.txt"), "clean worktree");
    await rm(path.join(dir, "secret.txt"));
    await writeFile(path.join(dir, ".gitattributes"), "secret.txt -diff\n");
    const envPath = await scanner(
      dir,
      'test "$(cat "$2/secret.txt")" = staged-secret-marker || exit 8; test ! -e "$2/.gitattributes" || exit 7; exit 9',
    );
    const before = git(dir, "write-tree").stdout.trim();
    const result = runPrecommit(dir, { PATH: envPath });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /staged-secret-marker/);
    assert.equal(git(dir, "write-tree").stdout.trim(), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps the generated Gitleaks policy outside a same-named staged blob", async () => {
  const dir = await setup();
  try {
    await writeFile(path.join(dir, "gitleaks-default.toml"), "staged-secret-marker");
    assert.equal(git(dir, "add", "--", "gitleaks-default.toml").status, 0);
    await rm(path.join(dir, "gitleaks-default.toml"));
    const envPath = await scanner(
      dir,
      'test "$(cat "$2/gitleaks-default.toml")" = staged-secret-marker || exit 8; exit 9',
    );
    const result = runPrecommit(dir, { PATH: envPath });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /staged-secret-marker/);
    assert.equal(git(dir, "show", ":gitleaks-default.toml").stdout, "staged-secret-marker");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("media guard extensions match the frontend picker and Rust validator", async () => {
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const frontend = await readFile(path.join(project, "src/app.tsx"), "utf8");
  const backend = await readFile(path.join(project, "src-tauri/src/media-file.rs"), "utf8");
  const extract = (source, declaration) => {
    const body = declaration.exec(source)?.[1];
    assert.ok(body, "media extension declaration found");
    return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  };
  assert.deepEqual(
    [...MEDIA_EXTENSIONS].sort(),
    extract(frontend, /const MEDIA_EXTENSIONS = \[([\s\S]*?)\];/),
  );
  assert.deepEqual(
    [...MEDIA_EXTENSIONS].sort(),
    extract(backend, /const MEDIA_EXTENSIONS: &\[&str\] = &\[([\s\S]*?)\];/),
  );
  for (const extension of MEDIA_EXTENSIONS) {
    assert.equal(isMediaArtifactPath(`recording.${extension}`), true, extension);
  }
  assert.equal(isMediaArtifactPath("src/features/audio.ts"), false);
  assert.equal(isMediaArtifactPath("public/cover.png"), false);
});

test("rejects staged library data before invoking the scanner", async () => {
  const dir = await setup();
  try {
    const envPath = await scanner(dir);
    await mkdir(path.join(dir, "library"));
    await writeFile(path.join(dir, "library", "library.db"), "synthetic");
    assert.equal(git(dir, "add", "--", "library/library.db").status, 0);
    const before = git(dir, "write-tree").stdout.trim();
    const result = runPrecommit(dir, { PATH: envPath });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing staged app data/);
    assert.equal(git(dir, "write-tree").stdout.trim(), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects staged SQLite artifacts outside the synthetic fixture directory", async () => {
  const dir = await setup();
  try {
    const envPath = await scanner(dir);
    for (const file of ["backup.sqlite", "backup.sqlite3"]) {
      await writeFile(path.join(dir, file), "synthetic database content");
      assert.equal(git(dir, "add", "--", file).status, 0);
    }
    const result = runPrecommit(dir, { PATH: envPath });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing staged app data or generated artifact/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("allows only small media under the dedicated synthetic fixture path", async () => {
  const dir = await setup();
  try {
    const envPath = await scanner(dir);
    const fixtureDir = path.join(dir, "tests", "fixtures", "synthetic");
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(path.join(fixtureDir, "sample.wav"), Buffer.from([1, 2, 3]));
    assert.equal(git(dir, "add", "--", "tests/fixtures/synthetic/sample.wav").status, 0);
    const result = runPrecommit(dir, { PATH: envPath });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("allows small SQLite fixtures only under the synthetic fixture directory", async () => {
  const dir = await setup();
  try {
    const envPath = await scanner(dir);
    const fixtureDir = path.join(dir, "tests", "fixtures", "synthetic");
    await mkdir(fixtureDir, { recursive: true });
    for (const file of ["sample.sqlite", "sample.sqlite3"]) {
      await writeFile(path.join(fixtureDir, file), "synthetic database content");
      assert.equal(git(dir, "add", "--", `tests/fixtures/synthetic/${file}`).status, 0);
    }
    const result = runPrecommit(dir, { PATH: envPath });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects oversized binary fixtures even in the synthetic fixture directory", async () => {
  const dir = await setup();
  try {
    const envPath = await scanner(dir);
    const fixtureDir = path.join(dir, "tests", "fixtures", "synthetic");
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(path.join(fixtureDir, "recording.wav"), Buffer.alloc(1024 * 1024 + 1));
    assert.equal(git(dir, "add", "--", "tests/fixtures/synthetic/recording.wav").status, 0);
    const result = runPrecommit(dir, { PATH: envPath });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing staged app data or generated artifact/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ignores staged deletions when building the temporary index", async () => {
  const dir = await setup();
  try {
    await writeFile(path.join(dir, "removed.txt"), "base\n");
    assert.equal(git(dir, "add", "--", "removed.txt").status, 0);
    assert.equal(git(dir, "commit", "-qm", "base").status, 0);
    assert.equal(git(dir, "rm", "removed.txt").status, 0);
    const envPath = await scanner(dir);
    const result = runPrecommit(dir, { PATH: envPath });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(dir, "ls-files", "--error-unmatch", "removed.txt").status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not block pre-existing artifacts when unrelated files are staged", async () => {
  const dir = await setup();
  try {
    await mkdir(path.join(dir, "target"));
    await writeFile(path.join(dir, "target", "old.bin"), "existing\n");
    assert.equal(git(dir, "add", "--", "target/old.bin").status, 0);
    assert.equal(git(dir, "commit", "-qm", "existing artifact").status, 0);
    await writeFile(path.join(dir, "ordinary.txt"), "safe\n");
    assert.equal(git(dir, "add", "--", "ordinary.txt").status, 0);
    const envPath = await scanner(dir);
    const result = runPrecommit(dir, { PATH: envPath });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails closed when Gitleaks is unavailable", async () => {
  const dir = await setup();
  try {
    const result = runPrecommit(dir, { PATH: "/usr/bin:/bin" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Gitleaks is required/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runs the relative pre-commit hook from a disposable Git repo", async () => {
  const dir = await setup();
  try {
    const envPath = await scanner(dir);
    const hooks = path.join(dir, ".husky");
    await mkdir(hooks);
    await mkdir(path.join(dir, "nested"));
    await writeFile(path.join(hooks, "pre-commit"), "#!/bin/sh\nnode pre-commit-checks.mjs\n", {
      mode: 0o755,
    });
    assert.equal(git(dir, "config", "core.hooksPath", ".husky").status, 0);
    await writeFile(path.join(dir, "ordinary.txt"), "safe\n");
    assert.equal(git(dir, "add", "--", "ordinary.txt").status, 0);
    const result = runGit(
      dir,
      ["-C", path.join(dir, "nested"), "commit", "-qm", "hook smoke"],
      process.env,
      { PATH: envPath },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(git(dir, "log", "-1", "--format=%s").stdout, /hook smoke/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("strips every inherited Git-local variable before operating on a foreign scratch repo", async () => {
  const sentinel = await setup();
  const scratch = await mkdtemp(path.join(os.tmpdir(), "syllen-foreign-git-test-"));
  try {
    await writeFile(path.join(sentinel, "sentinel.txt"), "sentinel\n");
    assert.equal(git(sentinel, "add", "--", "sentinel.txt").status, 0);
    assert.equal(git(sentinel, "config", "--local", "core.bare", "false").status, 0);
    assert.equal(git(sentinel, "config", "--local", "core.hooksPath", ".sentinel-hooks").status, 0);
    assert.equal(git(sentinel, "commit", "-qm", "sentinel").status, 0);

    const indexPath = path.resolve(
      sentinel,
      git(sentinel, "rev-parse", "--git-path", "index").stdout.trim(),
    );
    const sentinelHead = git(sentinel, "rev-parse", "HEAD").stdout.trim();
    const sentinelIndex = await readFile(indexPath);
    const sentinelConfig = await readFile(path.join(sentinel, ".git", "config"));
    const sentinelValues = {
      GIT_DIR: path.join(sentinel, ".git"),
      GIT_WORK_TREE: sentinel,
      GIT_INDEX_FILE: indexPath,
      GIT_COMMON_DIR: path.join(sentinel, ".git"),
      GIT_OBJECT_DIRECTORY: path.join(sentinel, ".git", "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(sentinel, ".git", "objects"),
      GIT_CONFIG: path.join(sentinel, ".git", "config"),
      GIT_PREFIX: "sentinel-prefix/",
    };
    const contaminatedEnv = { ...process.env };
    for (const name of localEnvNames) contaminatedEnv[name] = sentinelValues[name] ?? sentinel;

    await writeFile(path.join(scratch, "scratch.txt"), "scratch\n");
    assert.equal(runGit(scratch, ["init", "-q"], contaminatedEnv).status, 0);
    for (const args of [
      ["config", "user.name", "Scratch Test"],
      ["config", "user.email", "scratch@example.invalid"],
      ["add", "--", "scratch.txt"],
      ["commit", "-qm", "scratch"],
    ]) {
      assert.equal(runGit(scratch, args, contaminatedEnv).status, 0, args.join(" "));
    }

    assert.equal(git(sentinel, "rev-parse", "HEAD").stdout.trim(), sentinelHead);
    assert.deepEqual(await readFile(indexPath), sentinelIndex);
    assert.deepEqual(await readFile(path.join(sentinel, ".git", "config")), sentinelConfig);
    assert.equal(git(scratch, "rev-parse", "--show-toplevel").stdout.trim(), scratch);
    assert.equal(git(scratch, "rev-parse", "--is-bare-repository").stdout.trim(), "false");
    assert.equal(git(scratch, "log", "-1", "--format=%s").stdout.trim(), "scratch");
    assert.equal(git(scratch, "config", "--local", "--get", "core.hooksPath").status, 1);
  } finally {
    await rm(sentinel, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("the pre-commit runner honors an explicitly selected alternate index", async () => {
  const dir = await setup();
  try {
    await writeFile(path.join(dir, "base.txt"), "base\n");
    assert.equal(git(dir, "add", "--", "base.txt").status, 0);
    assert.equal(git(dir, "commit", "-qm", "base").status, 0);
    const mainTree = git(dir, "write-tree").stdout.trim();
    const alternateIndex = path.join(dir, ".git", "alternate-index");
    const alt = (args, overrides = {}) => runGit(dir, args, process.env, overrides);
    assert.equal(alt(["read-tree", "HEAD"], { GIT_INDEX_FILE: alternateIndex }).status, 0);

    await writeFile(path.join(dir, "alternate.txt"), "alternate-index staged\n");
    assert.equal(alt(["add", "--", "alternate.txt"], { GIT_INDEX_FILE: alternateIndex }).status, 0);
    const alternateTree = alt(["write-tree"], { GIT_INDEX_FILE: alternateIndex }).stdout.trim();
    await writeFile(path.join(dir, "alternate.txt"), "working tree version\n");

    const envPath = await scanner(
      dir,
      'test "$(cat "$2/alternate.txt")" = "alternate-index staged" || exit 0; echo found > "$HOOK_SCAN_MARKER"; exit 9',
    );
    const hooks = path.join(dir, ".husky");
    await mkdir(hooks);
    await writeFile(path.join(hooks, "pre-commit"), "#!/bin/sh\nnode pre-commit-checks.mjs\n", {
      mode: 0o755,
    });
    assert.equal(git(dir, "config", "core.hooksPath", ".husky").status, 0);
    const marker = path.join(dir, "scanner-saw-alternate-index");
    const result = runGit(dir, ["hook", "run", "pre-commit"], process.env, {
      GIT_INDEX_FILE: alternateIndex,
      PATH: envPath,
      HOOK_SCAN_MARKER: marker,
    });

    assert.notEqual(result.status, 0);
    assert.equal(await readFile(marker, "utf8"), "found\n");
    assert.equal(git(dir, "write-tree").stdout.trim(), mainTree);
    assert.equal(
      alt(["write-tree"], { GIT_INDEX_FILE: alternateIndex }).stdout.trim(),
      alternateTree,
    );
    assert.equal(await readFile(path.join(dir, "alternate.txt"), "utf8"), "working tree version\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
