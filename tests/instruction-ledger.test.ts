import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { ChatGptRetainedInstructionLedger } from "../src/adapters/chatgpt-web/instruction-ledger";

describe("ChatGptRetainedInstructionLedger", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-ledger-"));
  const statePath = join(dir, "instruction-ledger.json");

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unseen key proves no delivery and cannot classify", () => {
    const ledger = new ChatGptRetainedInstructionLedger(undefined);
    expect(ledger.delivered("key-a", "rev-1")).toBe(false);
    expect(ledger.deliveredAny("key-a")).toBe(false);
  });

  test("recording proves delivery of the exact revision content", () => {
    const ledger = new ChatGptRetainedInstructionLedger(undefined);
    ledger.record("key-a", ["rev-1", "rev-2"]);
    expect(ledger.delivered("key-a", "rev-1")).toBe(true);
    expect(ledger.delivered("key-a", "rev-2")).toBe(true);
    expect(ledger.delivered("key-a", "rev-3")).toBe(false);
    // A different conversation is unaffected.
    expect(ledger.delivered("key-b", "rev-1")).toBe(false);
  });

  test("forget clears the record so the next request reseeds fresh", () => {
    const ledger = new ChatGptRetainedInstructionLedger(undefined);
    ledger.record("key-a", ["rev-1"]);
    ledger.forget("key-a");
    expect(ledger.delivered("key-a", "rev-1")).toBe(false);
    expect(ledger.deliveredAny("key-a")).toBe(false);
    ledger.forget("key-a");
  });

  test("an edited resubmit under a seen key stays unproven after reseeding", () => {
    const ledger = new ChatGptRetainedInstructionLedger(undefined);
    ledger.record("key-a", ["rev-original"]);
    // The conversation is released and reseeded for the edited instruction.
    ledger.forget("key-a");
    ledger.record("key-a", ["rev-edited"]);
    expect(ledger.delivered("key-a", "rev-original")).toBe(false);
    expect(ledger.delivered("key-a", "rev-edited")).toBe(true);
  });

  test("recordings persist and survive a reload", () => {
    const first = new ChatGptRetainedInstructionLedger(statePath);
    first.record("key-persist", ["rev-1"]);
    const second = new ChatGptRetainedInstructionLedger(statePath);
    expect(second.delivered("key-persist", "rev-1")).toBe(true);
    expect(second.delivered("key-persist", "rev-2")).toBe(false);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ version: 1 });
  });

  test("an unreadable ledger file starts empty instead of failing the daemon", () => {
    const badPath = join(dir, "not-a-directory", "ledger.json");
    const ledger = new ChatGptRetainedInstructionLedger(join(badPath, "x.json"));
    expect(ledger.deliveredAny("key-x")).toBe(false);
  });

  test("per-key history is bounded", () => {
    const ledger = new ChatGptRetainedInstructionLedger(undefined);
    ledger.record("key-a", Array.from({ length: 200 }, (_, index) => `rev-${index}`));
    expect(ledger.delivered("key-a", "rev-199")).toBe(true);
    expect(ledger.delivered("key-a", "rev-0")).toBe(false);
  });
});
