import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  ChatGptConversationState,
  ConversationStateFile,
  conversationStatePath,
  sharedConversationStateFile,
} from "../src/adapters/chatgpt-web/conversation-state";

function state(dir: string, legacy: { ledger?: string; budget?: string; environment?: string } = {}): ChatGptConversationState {
  const file = new ConversationStateFile(join(dir, "conversations.jsonl"), {
    instructionLedger: legacy.ledger,
    inlineBudget: legacy.budget,
    threadEnvironment: legacy.environment,
  });
  return new ChatGptConversationState(file);
}

describe("ChatGptConversationState (conversations.jsonl)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-conversation-state-"));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unseen key proves no delivery and cannot classify", () => {
    const ledger = state(dir, {});
    expect(ledger.delivered("key-a", "rev-1")).toBe(false);
    expect(ledger.deliveredAny("key-a")).toBe(false);
  });

  test("recording proves delivery of the exact revision content", () => {
    const ledger = state(dir, {});
    ledger.record("key-a", ["rev-1", "rev-2"]);
    expect(ledger.delivered("key-a", "rev-1")).toBe(true);
    expect(ledger.delivered("key-a", "rev-2")).toBe(true);
    expect(ledger.delivered("key-a", "rev-3")).toBe(false);
    // A different conversation is unaffected.
    expect(ledger.delivered("key-b", "rev-1")).toBe(false);
  });

  test("forget clears the record so the next request reseeds fresh", () => {
    const ledger = state(dir, {});
    ledger.record("key-forget", ["rev-1"]);
    ledger.forget("key-forget");
    expect(ledger.delivered("key-forget", "rev-1")).toBe(false);
    expect(ledger.deliveredAny("key-forget")).toBe(false);
    ledger.forget("key-forget");
  });

  test("an edited resubmit under a seen key stays unproven after reseeding", () => {
    const ledger = state(dir, {});
    ledger.record("key-edit", ["rev-original"]);
    // The conversation is released and reseeded for the edited instruction.
    ledger.forget("key-edit");
    ledger.record("key-edit", ["rev-edited"]);
    expect(ledger.delivered("key-edit", "rev-original")).toBe(false);
    expect(ledger.delivered("key-edit", "rev-edited")).toBe(true);
  });

  test("per-key history is bounded", () => {
    const ledger = state(dir, {});
    ledger.record("key-bound", Array.from({ length: 200 }, (_, index) => `rev-${index}`));
    expect(ledger.delivered("key-bound", "rev-199")).toBe(true);
    expect(ledger.delivered("key-bound", "rev-0")).toBe(false);
  });

  test("inline spend accumulates per conversation and forget voids it", () => {
    const ledger = state(dir, {});
    expect(ledger.spent("key-spend")).toBeUndefined();
    ledger.recordInlineSpend("key-spend", 30_000);
    ledger.recordInlineSpend("key-spend", 40_000);
    expect(ledger.spent("key-spend")).toBe(70_000);
    // Non-positive recordings are ignored.
    ledger.recordInlineSpend("key-spend", 0);
    expect(ledger.spent("key-spend")).toBe(70_000);
    ledger.forget("key-spend");
    expect(ledger.spent("key-spend")).toBeUndefined();
  });

  test("recordings persist and survive a reload through the shared JSONL", () => {
    const scoped = mkdtempSync(join(tmpdir(), "cgw-conversation-persist-"));
    try {
      const ledgerPath = join(scoped, "instruction-ledger.json");
      const first = new ChatGptConversationState(new ConversationStateFile(
        conversationStatePath(ledgerPath),
        { instructionLedger: ledgerPath },
      ));
      first.record("key-persist", ["rev-1"]);
      const jsonl = conversationStatePath(ledgerPath)!;
      expect(existsSync(jsonl)).toBe(true);
      const second = new ChatGptConversationState(new ConversationStateFile(jsonl));
      expect(second.delivered("key-persist", "rev-1")).toBe(true);
      expect(second.delivered("key-persist", "rev-2")).toBe(false);
      // Append-only JSONL: one kind-discriminated JSON object per line.
      for (const line of readFileSync(jsonl, "utf8").trim().split("\n")) {
        expect(JSON.parse(line)).toMatchObject({ kind: "conversation" });
      }
    } finally {
      rmSync(scoped, { recursive: true, force: true });
    }
  });

  test("a corrupt line is skipped and the file keeps working (损坏即重建)", () => {
    const scoped = mkdtempSync(join(tmpdir(), "cgw-conversation-corrupt-"));
    try {
      const jsonl = join(scoped, "conversations.jsonl");
      writeFileSync(jsonl, '{"kind":"conversation","key":"good","deliveredRevisionIds":["rev-1"],"updatedAt":1}\n'
        + "{ this line is garbage\n"
        + '{"kind":"conversation","key":"other","inlineSpendTokens":1000,"updatedAt":2}\n', "utf8");
      const ledger = new ChatGptConversationState(new ConversationStateFile(jsonl));
      expect(ledger.delivered("good", "rev-1")).toBe(true);
      expect(ledger.spent("other")).toBe(1000);
      // The file remains writable and the store keeps appending.
      ledger.record("good", ["rev-2"]);
      const reloaded = new ChatGptConversationState(new ConversationStateFile(jsonl));
      expect(reloaded.delivered("good", "rev-2")).toBe(true);
    } finally {
      rmSync(scoped, { recursive: true, force: true });
    }
  });

  test("legacy ledger and budget files migrate once into the merged file", () => {
    const scoped = mkdtempSync(join(tmpdir(), "cgw-conversation-migrate-"));
    try {
      const ledgerPath = join(scoped, "instruction-ledger.json");
      const budgetPath = join(scoped, "inline-budget.json");
      writeFileSync(ledgerPath, JSON.stringify({ version: 1, keys: { "key-old": ["rev-old"] } }), "utf8");
      writeFileSync(budgetPath, JSON.stringify({ version: 1, spend: { "key-old": 12_345, "key-budget": 500 } }), "utf8");
      const migrated = state(scoped, { ledger: ledgerPath, budget: budgetPath });
      expect(migrated.delivered("key-old", "rev-old")).toBe(true);
      expect(migrated.spent("key-old")).toBe(12_345);
      expect(migrated.spent("key-budget")).toBe(500);
      expect(existsSync(conversationStatePath(ledgerPath)!)).toBe(true);
      // The merged file now owns the state; the legacy files are never written again.
      const reloaded = state(scoped);
      expect(reloaded.delivered("key-old", "rev-old")).toBe(true);
      expect(reloaded.spent("key-old")).toBe(12_345);
    } finally {
      rmSync(scoped, { recursive: true, force: true });
    }
  });

  test("the shared factory memoizes one file per path so appends never diverge", () => {
    const scoped = mkdtempSync(join(tmpdir(), "cgw-conversation-shared-"));
    try {
      const jsonl = join(scoped, "conversations.jsonl");
      const a = sharedConversationStateFile(jsonl);
      const b = sharedConversationStateFile(jsonl);
      expect(b).toBe(a);
      new ChatGptConversationState(a).record("shared-key", ["rev-1"]);
      expect(new ChatGptConversationState(b).delivered("shared-key", "rev-1")).toBe(true);
    } finally {
      rmSync(scoped, { recursive: true, force: true });
    }
  });
});
