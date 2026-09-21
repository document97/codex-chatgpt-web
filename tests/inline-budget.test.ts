import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { ChatGptInlineBudgetLedger } from "../src/adapters/chatgpt-web/inline-budget";

describe("ChatGptInlineBudgetLedger", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-inline-budget-"));
  const statePath = join(dir, "inline-budget.json");

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("an untracked conversation reports no spend", () => {
    const ledger = new ChatGptInlineBudgetLedger(undefined);
    expect(ledger.spent("key-a")).toBeUndefined();
  });

  test("spend accumulates per conversation and survives a reload", () => {
    const first = new ChatGptInlineBudgetLedger(statePath);
    first.record("key-a", 30_000);
    first.record("key-a", 40_000);
    first.record("key-b", 5_000);
    const second = new ChatGptInlineBudgetLedger(statePath);
    expect(second.spent("key-a")).toBe(70_000);
    expect(second.spent("key-b")).toBe(5_000);
    expect(second.spent("key-c")).toBeUndefined();
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ version: 1 });
  });

  test("forget voids the recorded spend for a released or reseeded conversation", () => {
    const ledger = new ChatGptInlineBudgetLedger(undefined);
    ledger.record("key-a", 30_000);
    ledger.forget("key-a");
    expect(ledger.spent("key-a")).toBeUndefined();
    ledger.forget("key-a");
  });

  test("non-positive recordings are ignored", () => {
    const ledger = new ChatGptInlineBudgetLedger(undefined);
    ledger.record("key-a", 0);
    expect(ledger.spent("key-a")).toBeUndefined();
  });
});
