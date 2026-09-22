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
  const compactSummary = "summary ".repeat(200);
  const compact = { type: "compaction", id: "cmp_local", encrypted_content: `ocx1:${Buffer.from(compactSummary, "utf8").toString("base64")}` };
  const hidden = { type: "reasoning", id: "rs_33333333333333333333333333333333", encrypted_content: "ocxr1:eyJ0eHQiOiJoaWRkZW4ifQ==" };
  const source = JSON.stringify({ type: "compacted", payload: { replacement_history: [local, native, compact, hidden] } }) + "\r\n";
  const { root, file } = tempSession(source);
  try {
    const result = repairSessionFile(file);
    assert.equal(result.changed, 3);
    assert.equal(fs.statSync(file).size, Buffer.byteLength(source));
    assert.equal(fs.readFileSync(result.backup, "utf8"), source);
    const payload = JSON.parse(fs.readFileSync(file, "utf8")).payload;
    assert.deepEqual(payload.replacement_history[0], { type: "reasoning", summary: [{ type: "summary_text", text: "keep" }] });
    assert.deepEqual(payload.replacement_history[1], native);
    assert.equal(payload.replacement_history[2].content[0].text.includes("summary"), true);
    assert.equal(payload.replacement_history.some(item => item.encrypted_content === hidden.encrypted_content), false);
    assert.equal(fs.readFileSync(file, "utf8").endsWith("\r\n"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("fails closed when a converted row cannot fit without moving later byte offsets", () => {
  const compact = { type: "compaction", id: "cmp_local", encrypted_content: `ocx1:${Buffer.from("x", "utf8").toString("base64")}` };
  const source = JSON.stringify({ type: "response_item", payload: compact }) + "\n";
  const { root, file } = tempSession(source);
  try {
    assert.throws(() => repairSessionFile(file), /would expand a JSONL row/);
    assert.equal(fs.readFileSync(file, "utf8"), source);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("repairs local reasoning ids in completed-item events while preserving summaries", () => {
  const source = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "Reasoning", id: "rs_44444444444444444444444444444444", summary_text: ["keep summary"] },
    },
  }) + "\n";
  const { root, file } = tempSession(source);
  try {
    const result = repairSessionFile(file);
    assert.equal(result.changed, 1);
    assert.equal(fs.statSync(file).size, Buffer.byteLength(source));
    const repaired = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(repaired.payload.item, { type: "Reasoning", summary_text: ["keep summary"] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("keeps downstream history_base byte offsets valid", () => {
  const first = JSON.stringify({ type: "event_msg", payload: { message: "prefix" } }) + "\n";
  const local = JSON.stringify({
    type: "response_item",
    payload: { type: "reasoning", id: "rs_55555555555555555555555555555555", summary: [{ type: "summary_text", text: "保留" }] },
  }) + "\r\n";
  const tail = JSON.stringify({ type: "event_msg", payload: { message: "tail" } }) + "\n";
  const source = first + local + tail;
  const tailOffset = Buffer.byteLength(first + local, "utf8");
  const { root, file } = tempSession(source);
  try {
    repairSessionFile(file);
    const repaired = fs.readFileSync(file);
    assert.equal(repaired.length, Buffer.byteLength(source));
    assert.equal(repaired.subarray(tailOffset).toString("utf8"), tail);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("repair scan is idempotent and leaves ordinary session files untouched", () => {
  const { root, file } = tempSession(JSON.stringify({ type: "event_msg", payload: { message: "ordinary" } }) + "\n");
  try {
    assert.deepEqual(repairCodexSessions(root), []);
    assert.equal(fs.readFileSync(file, "utf8"), '{"type":"event_msg","payload":{"message":"ordinary"}}\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
