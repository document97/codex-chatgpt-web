import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portableSessionCheckpoints, repairSessionCheckpoints } from "../src/portable-session-checkpoints";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";

const summaryText = ("完整摘要。Do not omit facts.\n").repeat(40);
const item = { type: "compaction", id: "cmp_local", encrypted_content: encodeCompactionSummary(summaryText) };
const line = (payload: unknown) => JSON.stringify({ type: "compacted", payload }) + "\r\n";
test("portable checkpoint preserves the exact summary, native ciphertext, metadata and ordinary text", () => {
  const native = { type: "compaction", id: "cmp_native", encrypted_content: "gAAAAopaque" };
  const ordinary = JSON.stringify({ type: "event_msg", payload: { message: "ocx1:example" } }) + "\n";
  const source = ordinary + line({ window_id: "window", replacement_history: [native, item], guardian_history: [item] });
  const result = portableSessionCheckpoints(source);
  expect(result.converted).toBe(2);
  expect(Buffer.byteLength(result.text)).toBe(Buffer.byteLength(source));
  expect(result.text.startsWith(ordinary)).toBe(true);
  const payload = JSON.parse(result.text.split("\n")[1]!).payload;
  expect(payload.window_id).toBe("window");
  expect(payload.replacement_history[0]).toEqual(native);
  expect(payload.replacement_history[1].content[0].text).toBe(`${SUMMARY_PREFIX}\n\n${summaryText}`);
  expect(portableSessionCheckpoints(result.text)).toEqual({ text: result.text, converted: 0 });
});
test("response items convert without touching official ones; malformed bridge data aborts", () => {
  expect(portableSessionCheckpoints(JSON.stringify({ type: "response_item", payload: item })).converted).toBe(1);
  expect(() => portableSessionCheckpoints(line({ replacement_history: [{ ...item, encrypted_content: "ocx1:???" }] }))).toThrow();
});

test("rejects a repair that would shift downstream byte offsets", () => {
  const short = { type: "compaction", id: "cmp_local", encrypted_content: encodeCompactionSummary("x") };
  expect(() => portableSessionCheckpoints(JSON.stringify({ type: "response_item", payload: short }) + "\n"))
    .toThrow("would expand a JSONL row");
});

test("completed-item events lose local reasoning ids but keep the summary", () => {
  const local = { type: "Reasoning", id: "rs_44444444444444444444444444444444", summary_text: ["keep"] };
  const result = portableSessionCheckpoints(JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: local } }) + "\n");
  expect(result.converted).toBe(1);
  expect(Buffer.byteLength(result.text)).toBe(Buffer.byteLength(JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: local } }) + "\n"));
  expect(JSON.parse(result.text).payload.item).toEqual({ type: "Reasoning", summary_text: ["keep"] });
});
test("offline repair retains a byte-exact backup and refuses an active writer", () => {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-repair-"));
  const file = join(root, "session.jsonl");
  const source = line({ replacement_history: [item] });
  try {
    writeFileSync(file, source);
    expect(() => repairSessionCheckpoints(file, () => { throw new Error("Codex running"); })).toThrow();
    expect(readFileSync(file, "utf8")).toBe(source);
    let checks = 0;
    expect(() => repairSessionCheckpoints(file, () => { if (++checks === 3) writeFileSync(file, source + "\n"); })).toThrow();
    expect(readFileSync(file, "utf8")).toBe(source + "\n");
    writeFileSync(file, source);
    const result = repairSessionCheckpoints(file, () => {});
    expect(readFileSync(result.backup!, "utf8")).toBe(source);
    expect(portableSessionCheckpoints(readFileSync(file, "utf8")).converted).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
