const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");

const bun = process.env.CODEX_CHATGPT_WEB_BUN;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, description) {
  const deadline = Date.now() + 12_000;
  do {
    if (await check()) return;
    await delay(40);
  } while (Date.now() < deadline);
  assert.fail(description);
}
async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

for (const scenario of ["tray handoff", "owner crash", "Windows Ctrl+C"]) {
  test(`native responses and compaction survive ${scenario}`, {
    skip: !bun || process.platform !== "win32" ? "requires Windows and CODEX_CHATGPT_WEB_BUN" : false,
    timeout: 35_000,
  }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-lifecycle-"));
    const codexHome = path.join(root, "codex");
    fs.mkdirSync(codexHome);
    const baseline = 'model = "gpt-5.6-sol"\n';
    fs.writeFileSync(path.join(codexHome, "config.toml"), baseline);
    const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
    fs.mkdirSync(path.dirname(descriptorPath));
    const port = await freePort();
    const config = {
      version: 3, releaseVersion: "5.0.7", mode: "browser-only", host: "127.0.0.1", port,
      contextWindow: 90_000, appName: "Codex Native2", browserHost: "launcher",
      browserHostDescriptorPath: descriptorPath, chromeExecutablePath: process.execPath,
      storageStatePath: path.join(root, "storage-state.json"),
      brokerSocketPath: `\\\\.\\pipe\\codex-fixture-${process.pid}-${port}`,
      headed: true, solAvailable: true, proAvailable: false, autoApproveToolCalls: false,
      subagentProtocol: "native", controlToken: "fixture-control-token-0123456789abcdef0123456789abcdef",
      runtimeCommand: [bun, path.resolve(__dirname, "../../src/cli.ts")],
    };
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(config));
    const consumer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    const ownerLog = fs.openSync(path.join(root, "owner.log"), "a");
    let ownerExecutable = process.execPath;
    let ownerArguments = [path.join(__dirname, "fixtures/native-fallback-owner.cjs"), root, bun, String(consumer.pid)];
    if (scenario === "Windows Ctrl+C") {
      // Start-Process gives the owner a separate hidden console for a real Ctrl+C event.
      // Keep the PowerShell wrapper attached: detached + windowsHide can make Windows
      // PowerShell exit successfully without executing this script.
      const quotePS = value => `'${value.replaceAll("'", "''")}'`;
      const argumentsString = ownerArguments.map(value => `"${value}"`).join(" ");
      const startScript = `$ErrorActionPreference = 'Stop'\nStart-Process -FilePath ${quotePS(process.execPath)} -ArgumentList ${quotePS(argumentsString)} -WorkingDirectory ${quotePS(path.resolve(__dirname, "../.."))} -WindowStyle Hidden -RedirectStandardOutput ${quotePS(path.join(root, "owner-stdout.log"))} -RedirectStandardError ${quotePS(path.join(root, "owner-stderr.log"))} -Wait\n`;
      fs.writeFileSync(path.join(root, "start-owner.ps1"), startScript);
      ownerExecutable = "powershell.exe";
      ownerArguments = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "start-owner.ps1")];
    }
    const owner = spawn(ownerExecutable, ownerArguments, {
      detached: scenario !== "Windows Ctrl+C", windowsHide: true, stdio: ["ignore", ownerLog, ownerLog],
      env: { ...process.env, CODEX_HOME: codexHome, CODEX_CHATGPT_WEB_HOME: root },
    });
    fs.closeSync(ownerLog);
    let daemonPid;
    let ownerPid = owner.pid;
    let requests = [];
    try {
      await eventually(() => {
        if (owner.exitCode !== null) throw new Error(`Owner exited before ready: ${owner.exitCode}; root=${root}`);
        return fs.existsSync(path.join(root, "ready.json"));
      }, `daemon did not start; root=${root}`);
      const ready = JSON.parse(fs.readFileSync(path.join(root, "ready.json"), "utf8"));
      daemonPid = ready.pid;
      ownerPid = ready.ownerPid;
      assert.match(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), /openai_base_url/);
      const base = `http://127.0.0.1:${port}`;
      requests = ["responses", "responses/compact"].map(endpoint => fetch(`${base}/v1/${endpoint}`, {
        method: "POST",
        headers: { authorization: "Bearer fixture-session", "content-type": "application/json", "x-fixture-delay": "3500" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: [], stream: false }),
      }).then(async response => ({ status: response.status, body: await response.json() })));
      // Attach handlers immediately so an interruption is reported as an assertion, not unhandled rejection.
      const pending = Promise.allSettled(requests);
      await eventually(async () => (await fetch(`${base}/healthz`).then(r => r.json())).active_http_turns === 2,
        "native response and compaction were not both in flight");
      if (scenario === "tray handoff") fs.writeFileSync(path.join(root, "quit"), "quit");
      else if (scenario === "owner crash") owner.kill("SIGKILL");
      else {
        // Attach a throwaway helper to the isolated owner console, never to the test/Codex console.
        const script = [
          'Add-Type -TypeDefinition @"',
          'using System; using System.Runtime.InteropServices; public class FixtureCtrl {',
          '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();',
          '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);',
          '[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);',
          '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint evt, uint group); }',
          '"@',
          '[void][FixtureCtrl]::FreeConsole()',
          `if (![FixtureCtrl]::AttachConsole(${ownerPid})) { exit 2 }`,
          '[void][FixtureCtrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)',
          'if (![FixtureCtrl]::GenerateConsoleCtrlEvent(0, 0)) { exit 3 }',
          'Start-Sleep -Milliseconds 300',
        ].join("\n");
        const helper = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
          windowsHide: true, encoding: "utf8", timeout: 10_000,
        });
        assert.equal(helper.status, 0, helper.stderr);
      }
      await eventually(() => !alive(ownerPid), "launcher owner did not exit");
      await eventually(async () => {
        try { return (await fetch(`${base}/healthz`).then(r => r.json())).native_fallback_only === true; }
        catch { return false; }
      }, "daemon did not survive in fallback mode");
      assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), baseline);
      const results = await pending;
      for (const result of results) {
        assert.equal(result.status, "fulfilled", JSON.stringify(result));
        assert.equal(result.value.status, 200);
        assert.equal(result.value.body.status, "completed");
      }
      // Later compaction still works; this tests sustained fallback, not only one surviving connection.
      const after = await fetch(`${base}/v1/responses/compact`, {
        method: "POST", headers: { authorization: "Bearer fixture-session", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
      });
      assert.equal(after.status, 200);
      await after.arrayBuffer();
      assert.equal(fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8"), '{"fixture_roster":"installed-once"}\n');
      consumer.kill();
      await eventually(async () => {
        try { await fetch(`${base}/healthz`); return false; } catch { return true; }
      }, "fallback listener remained after the last Codex fixture exited");
    } catch (error) {
      for (const filename of ["owner.log", "owner-stdout.log", "owner-stderr.log", "logs/responses-daemon.log"]) {
        if (fs.existsSync(path.join(root, filename))) console.error(fs.readFileSync(path.join(root, filename), "utf8"));
      }
      throw error;
    } finally {
      owner.kill();
      if (ownerPid !== owner.pid && alive(ownerPid)) process.kill(ownerPid, "SIGKILL");
      consumer.kill();
      if (daemonPid && alive(daemonPid)) process.kill(daemonPid, "SIGKILL");
      await Promise.allSettled(requests);
      await delay(100);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
