const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { repairSessionFile, repairCodexSessions } = require("../electron/session-checkpoint-repair.cjs");

function tempSession(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-repair-"));
  const sessions = path.join(root, "sessions", "2026", "09", "16");
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, "rollout-test.jsonl");
  fs.writeFileSync(file, text);
  return { root, file };
}

test("repairs local reasoning ids and bridge compaction while preserving native encrypted items", () => {
  const local = { type: "reasoning", id: "rs_11111111111111111111111111111111", summary: [{ type: "summary_text", text: "keep" }], encrypted_content: null };
  const native = { type: "reasoning", id: "rs_22222222222222222222222222222222", encrypted_content: "gAAAA-native" };
  const compact = { type: "compaction", id: "cmp_local", encrypted_content: `ocx1:${Buffer.from("summary", "utf8").toString("base64")}` };
  const hidden = { type: "reasoning", id: "rs_33333333333333333333333333333333", encrypted_content: "ocxr1:eyJ0eHQiOiJoaWRkZW4ifQ==" };
  const source = JSON.stringify({ type: "compacted", payload: { replacement_history: [local, native, compact, hidden] } }) + "\r\n";
  const { root, file } = tempSession(source);
  try {
    const result = repairSessionFile(file);
    assert.equal(result.changed, 3);
    assert.equal(fs.readFileSync(result.backup, "utf8"), source);
    const payload = JSON.parse(fs.readFileSync(file, "utf8")).payload;
    assert.deepEqual(payload.replacement_history[0], { type: "reasoning", summary: [{ type: "summary_text", text: "keep" }] });
    assert.deepEqual(payload.replacement_history[1], native);
    assert.equal(payload.replacement_history[2].content[0].text.includes("summary"), true);
    assert.equal(payload.replacement_history.some(item => item.encrypted_content === hidden.encrypted_content), false);
    assert.equal(fs.readFileSync(file, "utf8").endsWith("\r\n"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("repair scan is idempotent and leaves ordinary session files untouched", () => {
  const { root, file } = tempSession(JSON.stringify({ type: "event_msg", payload: { message: "ordinary" } }) + "\n");
  try {
    assert.deepEqual(repairCodexSessions(root), []);
    assert.equal(fs.readFileSync(file, "utf8"), '{"type":"event_msg","payload":{"message":"ordinary"}}\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
