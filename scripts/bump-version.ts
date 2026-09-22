// Single-command version bump. This replaces the old check-version.ts gate: instead of
// turning CI red when one of the versioned touchpoints is forgotten, this script rewrites
// every touchpoint in one shot and fails immediately if the repo has drifted.
//
// Usage:
//   bun run bump 1.4.1                 # bump the app version everywhere
//   bun run bump 1.4.1 --bun 1.4.1     # bump app version and the pinned Bun toolchain
//   bun run bump --bun 1.4.1           # bump only the pinned Bun toolchain
//
// After bumping, commit the result and cut the release as usual.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const args = process.argv.slice(2);
let appVersion: string | undefined;
let bunVersion: string | undefined;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--bun") {
    bunVersion = args[i + 1];
    i += 1;
  } else if (!arg.startsWith("--") && appVersion === undefined) {
    appVersion = arg;
  } else {
    throw new Error(`Unexpected argument: ${arg}`);
  }
}

const semver = /^\d+\.\d+\.\d+$/;
if (appVersion !== undefined && !semver.test(appVersion)) throw new Error(`Invalid app version: ${appVersion}`);
if (bunVersion !== undefined && !semver.test(bunVersion)) throw new Error(`Invalid Bun version: ${bunVersion}`);
if (appVersion === undefined && bunVersion === undefined) {
  throw new Error("Usage: bun run bump <app-version> [--bun <bun-version>]");
}

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  version?: string;
  packageManager?: string;
};
const currentApp = packageJson.version;
if (!currentApp) throw new Error("package.json has no version");
const currentBun = /^bun@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager ?? "")?.[1];
if (!currentBun) throw new Error("package.json packageManager must pin bun@<semver>");

let changed = 0;

function rewrite(relPath: string, pairs: Array<readonly [string, string]>): void {
  const abs = resolve(root, relPath);
  let text = readFileSync(abs, "utf8");
  let touched = false;
  for (const [from, to] of pairs) {
    if (from === to) continue;
    if (!text.includes(from)) {
      throw new Error(`${relPath} no longer contains ${JSON.stringify(from)} — the repo drifted; fix that touchpoint by hand once`);
    }
    text = text.split(from).join(to);
    touched = true;
  }
  if (touched) {
    writeFileSync(abs, text);
    changed += 1;
    console.log(`updated ${relPath}`);
  }
}

if (appVersion !== undefined && appVersion !== currentApp) {
  rewrite("package.json", [[`"version": "${currentApp}"`, `"version": "${appVersion}"`]]);
  rewrite("launcher/package.json", [[`"version": "${currentApp}"`, `"version": "${appVersion}"`]]);
  rewrite("src/version.ts", [[`export const VERSION = "${currentApp}";`, `export const VERSION = "${appVersion}";`]]);
  rewrite("scripts/install.sh", [[`CODEX_CHATGPT_WEB_VERSION:-${currentApp}`, `CODEX_CHATGPT_WEB_VERSION:-${appVersion}`]]);
}

if (bunVersion !== undefined && bunVersion !== currentBun) {
  rewrite("package.json", [
    [`"packageManager": "bun@${currentBun}"`, `"packageManager": "bun@${bunVersion}"`],
    [`"@types/bun": "${currentBun}"`, `"@types/bun": "${bunVersion}"`],
    [`"bun": "${currentBun}"`, `"bun": "${bunVersion}"`],
  ]);
  rewrite("scripts/install.sh", [[`Bun-${currentBun}.md`, `Bun-${bunVersion}.md`]]);
  rewrite("scripts/generate-third-party-notices.ts", [[`Bun ${currentBun}`, `Bun ${bunVersion}`]]);
  rewrite(".github/workflows/ci.yml", [
    [`bun-version: ${currentBun}`, `bun-version: ${bunVersion}`],
    [`-Version ${currentBun}`, `-Version ${bunVersion}`],
  ]);
  rewrite(".github/workflows/release.yml", [
    [`bun-version: ${currentBun}`, `bun-version: ${bunVersion}`],
    [`Bun-${currentBun}.md`, `Bun-${bunVersion}.md`],
    [`-Version ${currentBun}`, `-Version ${bunVersion}`],
  ]);
}

if (changed === 0) {
  console.log(`already at app@${currentApp} bun@${currentBun} — nothing to do`);
} else {
  for (const cwd of [root, resolve(root, "launcher")]) {
    const result = Bun.spawnSync([process.execPath, "install", "--lockfile-only"], {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      console.warn(`warning: lockfile refresh failed in ${cwd}; run bun install there manually`);
    }
  }
  console.log(`bumped app@${appVersion ?? currentApp} bun@${bunVersion ?? currentBun} across ${changed} file(s)`);
}
