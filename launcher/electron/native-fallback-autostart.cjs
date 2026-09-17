const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_RUN_VALUE = "Codex Web GPT Native Fallback";
const WINDOWS_TASK_NAME = "Codex Web GPT\\Native Fallback Recovery";

function registryExecutable() {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  return path.join(systemRoot, "System32", "reg.exe");
}

function taskSchedulerExecutable() {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  return path.join(systemRoot, "System32", "schtasks.exe");
}

function removeLegacyRecoveryEntries(coreHome) {
  if (process.platform !== "win32") return;
  // Older builds could register these entries. Remove them when the launcher starts;
  // the current build never creates them because hidden Windows startup integration is disabled.
  spawnSync(taskSchedulerExecutable(), ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  spawnSync(registryExecutable(), ["DELETE", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (coreHome) fs.rmSync(path.join(coreHome, "bin", "native-fallback-startup.vbs"), { force: true });
}

function setNativeFallbackAutostart(_invocation, coreHome, enabled) {
  removeLegacyRecoveryEntries(coreHome);
  return {
    supported: process.platform === "win32",
    enabled: false,
    disabledByUserPolicy: true,
    requested: enabled === true,
  };
}

module.exports = {
  WINDOWS_RUN_KEY,
  WINDOWS_RUN_VALUE,
  WINDOWS_TASK_NAME,
  setNativeFallbackAutostart,
};
