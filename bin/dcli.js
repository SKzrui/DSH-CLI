#!/usr/bin/env node
// dcli — the launcher. Resolves the DeepSeek Harness `dsh` installation,
// self-heals the `cli` profile under $DSH_HOME, and boots it, forwarding all
// arguments. The interactive runner lives in the profile as ./runner.js.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const requireFromHere = createRequire(import.meta.url);
// Single source of truth: report the version from this package's manifest.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// The dsh launcher owns `--version` for itself; intercept ours so `dcli
// --version` reports dcli, not the harness — and touches nothing on disk.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Locate the dsh installation.
// ---------------------------------------------------------------------------
function resolveDshBin() {
  // Order matters: prefer the dsh version pinned as dcli's own dependency
  // (root/node_modules), so a user's separately installed dsh at a different
  // version never drifts dcli onto untested internals. Then the common
  // install locations, then local/ancestor installs.
  const candidates = [
    process.env.DCLI_DSH_BIN,
    join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    join(homedir(), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    join(process.env.APPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    // Local installs: dsh living in the current directory's node_modules (or
    // any ancestor), e.g. D:\DCLI\node_modules\@deepseek-ai\dsh.
    join(process.cwd(), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // General fallback 1: resolve like any Node import, walking up from this
  // package. This is what finds dsh when it's installed as a normal global
  // dependency (hoisted into the npm prefix root), on any platform.
  try {
    return requireFromHere.resolve("@deepseek-ai/dsh/lib/bin.js");
  } catch {
    // fall through
  }
  // General fallback 2: resolve from the working directory, so a local dsh in
  // any ancestor's node_modules is found even when dcli itself is global.
  try {
    const requireFromCwd = createRequire(join(process.cwd(), "dcli-resolve.js"));
    return requireFromCwd.resolve("@deepseek-ai/dsh/lib/bin.js");
  } catch {
    // fall through
  }
  console.error(
    "dcli: cannot locate the @deepseek-ai/dsh installation.\n" +
      "  Install it once (npm i -g @deepseek-ai/dsh) or point DCLI_DSH_BIN at its lib/bin.js."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Self-heal the `cli` profile.
// ---------------------------------------------------------------------------
const PROFILE_PATCH = `# dcli — interactive agent profile for the DeepSeek Harness.
# Bundles: dsh-base (core machinery) + dsh-headless (coding persona, tool mode,
# code-runtime). This user layer disables the one-shot headless driver and
# mounts the interactive cli-runner from ./runner.js.
- id: headless-startup
  disabled: true

- id: headless-runner
  disabled: true

- insert:
    - id: cli-runner
      name: './runner.js'
    - id: tool-ask-user
      name: '@deepseek-ai/dsh-tool-ask-user'
`;

const PROFILE_MANIFEST = JSON.stringify(
  {
    name: "dsh-profile-cli",
    private: true,
    type: "module",
    dependencies: {},
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
      },
    },
  },
  null,
  2
) + "\n";

const PROFILE_ROOT = "# dsh profile root — an empty entry list; edit cordis.patch.yml, not this file.\n[]\n";

const PNPM_WORKSPACE = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";

function ensureProfile() {
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
  const profileDir = join(dshHome, "profiles", "cli");
  mkdirSync(profileDir, { recursive: true });

  const staticFiles = {
    "package.json": PROFILE_MANIFEST,
    "cordis.yml": PROFILE_ROOT,
    "cordis.patch.yml": PROFILE_PATCH,
    "pnpm-workspace.yaml": PNPM_WORKSPACE,
  };
  for (const [name, content] of Object.entries(staticFiles)) {
    const target = join(profileDir, name);
    if (!existsSync(target)) writeFileSync(target, content);
  }

  // Keep the runner in sync with this package (rewrite only when it changed).
  const runnerSrc = join(root, "runner", "runner.js");
  const runnerDst = join(profileDir, "runner.js");
  const src = readFileSync(runnerSrc, "utf8");
  if (!existsSync(runnerDst) || readFileSync(runnerDst, "utf8") !== src) {
    writeFileSync(runnerDst, src);
  }

  return profileDir;
}

// ---------------------------------------------------------------------------
// 3. Boot.
// ---------------------------------------------------------------------------
const dshBin = resolveDshBin();
const profileDir = ensureProfile();

const child = spawn(process.execPath, [dshBin, "--profile", "cli", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
  windowsHide: false,
});

// Signal handling: the child shares this console, so it receives the user's
// Ctrl+C directly and tears down gracefully (flush + dispose + exit). The
// launcher must NOT TerminateProcess it on the first signal, or the session
// flush is lost. We only hard-kill after a grace period, or on a second
// Ctrl+C.
let sigintCount = 0;
process.on("SIGINT", () => {
  sigintCount += 1;
  if (sigintCount >= 2) {
    if (child.exitCode === null && !child.killed) child.kill();
    return;
  }
  setTimeout(() => {
    if (child.exitCode === null && !child.killed) child.kill();
  }, 15000).unref();
});
process.on("SIGTERM", () => {
  if (child.exitCode === null && !child.killed) child.kill();
});

child.on("error", (error) => {
  console.error(`dcli: failed to start dsh: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
