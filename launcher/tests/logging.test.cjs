const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const {
  createLogger,
  exportSanitizedLogs,
  installProcessDiagnosticGuards,
  registerLoggedIpc,
  sanitize,
} = require("../electron/logging.cjs");

test("launcher logs redact tunnel ids, runtime keys, and bearer credentials", () => {
  assert.deepEqual(sanitize({
    line: "tunnel_0123456789abcdef0123456789abcdef sk-exampleRuntimeSecret123",
    authorization: "Bearer this-must-never-be-recorded",
    nested: { controlToken: "also-secret" },
  }), {
    line: "[tunnel-id] [runtime-key]",
    authorization: "[redacted]",
    nested: { controlToken: "[redacted]" },
  });
});

test("failed launcher IPC calls are written to runtime activity", async () => {
  let registered;
  const errors = [];
  const ipcMain = {
    handle(channel, handler) {
      registered = { channel, handler };
    },
  };
  registerLoggedIpc(
    ipcMain,
    { error: (event, detail) => errors.push({ event, detail }) },
    "launcher:test",
    async () => {
      throw new Error("visible failure");
    },
  );

  await assert.rejects(registered.handler({}, 1), /visible failure/);
  assert.deepEqual(errors, [{
    event: "launcher.ipc_failed",
    detail: { channel: "launcher:test", message: "visible failure" },
  }]);
});

test("launcher activity restores valid records from the previous process", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-logging-"));
  const filePath = path.join(root, "launcher.jsonl");
  try {
    fs.writeFileSync(filePath, [
      JSON.stringify({ at: "2026-07-28T00:00:00.000Z", level: "info", event: "previous", detail: {} }),
      "not-json",
      "",
    ].join("\n"));
    const logger = createLogger({ filePath });
    assert.deepEqual(logger.recent().map((record) => record.event), ["previous"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exported launcher logs remove local usernames, private ChatGPT titles, and URL paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-export-"));
  const filePath = path.join(root, "launcher.jsonl");
  const destinationPath = path.join(root, "shared", "diagnostics.jsonl");
  try {
    fs.writeFileSync(`${filePath}.1`, `${JSON.stringify({
      at: "2026-08-23T00:00:00.000Z",
      level: "error",
      event: "runtime.daemon_stdout",
      detail: {
        line: "prompt_attachment failed at C:\\Users\\private.user\\.codex and encoded C:\\\\Users\\\\private.user\\\\.codex; connector missing; visible rows: Private roadmap, Health notes",
      },
    })}\n`);
    fs.writeFileSync(filePath, `${JSON.stringify({
      at: "2026-08-23T00:01:00.000Z",
      level: "info",
      event: "runtime.stdout",
      detail: {
        line: "config loaded from /Users/local-person/.codex/config.toml",
        prompt: "private prompt",
        connector: "Codex Native2",
        url: "https://chatgpt.com/c/private-conversation?state=oauth-secret&email=private@example.com",
        message: "failed while loading 'https://accounts.google.com/o/oauth2/v2/auth?state=oauth-secret&login_hint=private@example.com'",
      },
    })}\n`);

    assert.equal(exportSanitizedLogs({ filePath, destinationPath }), 2);
    const exported = fs.readFileSync(destinationPath, "utf8");
    assert.doesNotMatch(exported, /private\.user|local-person|Private roadmap|Health notes|private prompt|private-conversation|oauth-secret|private@example\.com/);
    assert.match(exported, /\[user-home\]/);
    assert.match(exported, /visible rows: \[redacted\]/);
    assert.match(exported, /Codex Native2/);
    assert.match(exported, /"prompt":"\[redacted\]"/);
    assert.match(exported, /https:\/\/chatgpt\.com/);
    assert.match(exported, /https:\/\/accounts\.google\.com/);
    assert.throws(
      () => exportSanitizedLogs({ filePath, destinationPath: filePath }),
      /Refusing to overwrite a launcher source log/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an exported diagnostic carries the untimestamped runtime daemon tail in file order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-export-daemon-"));
  const filePath = path.join(root, "launcher.jsonl");
  const daemonPath = path.join(root, "logs", "responses-daemon.log");
  const destinationPath = path.join(root, "export.jsonl");
  try {
    fs.mkdirSync(path.dirname(daemonPath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({
      at: "2026-09-19T09:17:58.904Z",
      level: "info",
      event: "browser.turn_ended",
      detail: {},
    })}\n`);
    fs.writeFileSync(daemonPath, [
      "[chatgpt-web] broker trace=828d45c1389c registered tokenHash=c668ebb86ce0",
      "browser turn 828d45c1389c ended without codex_turn_complete; requesting one retained recovery",
      "read C:\\Users\\private.user\\work\\plan.md",
      "tunnel_0123456789abcdef0123456789abcdef",
    ].join("\n"));

    const count = exportSanitizedLogs({ filePath, destinationPath, textLogPaths: [daemonPath] });
    const records = fs.readFileSync(destinationPath, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    assert.equal(count, 6);
    assert.deepEqual(records.map(record => record.event), [
      "browser.turn_ended",
      "runtime.text_log_tail",
      "runtime.text_log_line",
      "runtime.text_log_line",
      "runtime.text_log_line",
      "runtime.text_log_line",
    ]);
    assert.deepEqual(records[1].detail, { sourceFile: "responses-daemon.log", lines: 4, omittedLines: 0 });
    assert.equal(records[2].detail.seq, 1);
    assert.match(records[2].detail.line, /registered tokenHash=/);
    assert.match(records[3].detail.line, /requesting one retained recovery/);
    assert.match(records[4].detail.line, /\[user-home\]/);
    assert.match(records[5].detail.line, /\[tunnel-id\]/);
    assert.doesNotMatch(fs.readFileSync(destinationPath, "utf8"), /private\.user|tunnel_0123456789/);

    exportSanitizedLogs({ filePath, destinationPath, textLogPaths: [path.join(root, "absent.log")] });
    assert.equal(fs.readFileSync(destinationPath, "utf8").trim().split("\n").length, 1);
    assert.throws(
      () => exportSanitizedLogs({
        filePath,
        destinationPath: daemonPath,
        textLogPaths: [daemonPath],
      }),
      /Refusing to overwrite a runtime source log/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a closed Windows diagnostic pipe is recorded without becoming an uncaught process error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-process-pipe-"));
  const filePath = path.join(root, "process-stream-errors.log");
  const stream = new PassThrough();
  try {
    installProcessDiagnosticGuards({ filePath, streams: [stream] });
    stream.emit("error", Object.assign(new Error("write EOF"), { code: "EOF" }));
    assert.match(fs.readFileSync(filePath, "utf8"), /write EOF/);
  } finally {
    stream.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
