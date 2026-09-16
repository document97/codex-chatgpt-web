const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_RUN_VALUE = "Codex Web GPT Native Fallback";

function requirePlainCommandPart(value) {
  const part = String(value);
  if (!part || /["\r\n]/.test(part)) {
    throw new Error("Native fallback startup command contains an unsupported character");
  }
  return part;
}

function quotedCommandPart(value) {
  return `"${requirePlainCommandPart(value)}"`;
}

function vbsString(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function fallbackScript(invocation) {
  const command = [invocation.executable, ...invocation.args]
    .map(quotedCommandPart)
    .join(" ");
  return [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = ${vbsString(invocation.cwd)}`,
    `shell.Run ${vbsString(command)}, 0, False`,
    "",
  ].join("\r\n");
}

function registryExecutable() {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  return path.join(systemRoot, "System32", "reg.exe");
}

function runRegistry(args) {
  const result = spawnSync(registryExecutable(), args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || String(result.stderr || result.stdout || "unknown registry error").trim();
    throw new Error(`Could not update native fallback startup: ${detail}`);
  }
}

function setNativeFallbackAutostart(invocation, coreHome, enabled) {
  if (process.platform !== "win32") return { supported: false, enabled: false };
  const scriptPath = path.join(coreHome, "bin", "native-fallback-startup.vbs");
  if (!enabled) {
    spawnSync(registryExecutable(), ["DELETE", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    fs.rmSync(scriptPath, { force: true });
    return { supported: true, enabled: false, scriptPath };
  }
  if (!invocation || !path.isAbsolute(invocation.executable) || !path.isAbsolute(invocation.cwd)) {
    throw new Error("Native fallback startup requires a durable absolute runtime invocation");
  }
  invocation = {
    ...invocation,
    args: [
      ...invocation.args,
      "--startup-log",
      path.join(coreHome, "logs", "native-fallback-startup.log"),
    ],
  };
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(scriptPath, fallbackScript(invocation));
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const wscript = path.join(systemRoot, "System32", "wscript.exe");
  const registryCommand = `${quotedCommandPart(wscript)} //B //NoLogo ${quotedCommandPart(scriptPath)}`;
  runRegistry([
    "ADD",
    WINDOWS_RUN_KEY,
    "/v",
    WINDOWS_RUN_VALUE,
    "/t",
    "REG_SZ",
    "/d",
    registryCommand,
    "/f",
  ]);
  return { supported: true, enabled: true, scriptPath };
}

module.exports = {
  WINDOWS_RUN_KEY,
  WINDOWS_RUN_VALUE,
  fallbackScript,
  setNativeFallbackAutostart,
};
