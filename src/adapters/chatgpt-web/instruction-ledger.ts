import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_KEYS = 64;
const MAX_REVISIONS_PER_KEY = 128;

interface LedgerFile {
  version: 1;
  keys: Record<string, string[]>;
}

/**
 * Records which user instructions each retained browser conversation already carried. Codex
 * reopens an edited or resumed task under a new native turn_id while the last human instruction
 * still belongs to the older turn, so the request body alone cannot tell a resume (continue the
 * retained conversation) from an edit-resubmit (seed a fresh conversation from canonical
 * history). A revision hash present in this ledger proves the exact instruction content was
 * already delivered; its absence means the adapter must assume the edited case.
 *
 * Persistence is best-effort: a lost ledger only costs one conservative full-history replay.
 */
export class ChatGptRetainedInstructionLedger {
  private readonly keys = new Map<string, string[]>();

  constructor(private readonly statePath: string | undefined) {
    if (!statePath) return;
    try {
      if (!existsSync(statePath)) return;
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as LedgerFile;
      if (parsed?.version !== 1 || typeof parsed.keys !== "object" || parsed.keys === null) return;
      for (const [key, revisions] of Object.entries(parsed.keys)) {
        if (!Array.isArray(revisions)) continue;
        this.keys.set(key, revisions.filter(value => typeof value === "string").slice(-MAX_REVISIONS_PER_KEY));
      }
    } catch (error) {
      console.warn(`[chatgpt-web] retained instruction ledger was unreadable and starts empty: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Whether this exact instruction content already reached the retained conversation. */
  delivered(conversationKey: string, revisionId: string): boolean {
    return this.keys.get(conversationKey)?.includes(revisionId) === true;
  }

  deliveredAny(conversationKey: string): boolean {
    return (this.keys.get(conversationKey)?.length ?? 0) > 0;
  }

  record(conversationKey: string, revisionIds: readonly string[]): void {
    if (revisionIds.length === 0) return;
    const merged = [...new Set([
      ...(this.keys.get(conversationKey) ?? []),
      ...revisionIds,
    ])].slice(-MAX_REVISIONS_PER_KEY);
    this.keys.delete(conversationKey);
    this.keys.set(conversationKey, merged);
    while (this.keys.size > MAX_KEYS) {
      const oldest = this.keys.keys().next().value;
      if (oldest === undefined) break;
      this.keys.delete(oldest);
    }
    this.persist();
  }

  /** The conversation was released or reseeded; its delivered-instruction record is void. */
  forget(conversationKey: string): void {
    if (!this.keys.has(conversationKey)) return;
    this.keys.delete(conversationKey);
    this.persist();
  }

  private persist(): void {
    if (!this.statePath) return;
    const file: LedgerFile = {
      version: 1,
      keys: Object.fromEntries([...this.keys.entries()]),
    };
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(file), "utf8");
    } catch (error) {
      console.warn(`[chatgpt-web] failed to persist the retained instruction ledger: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  }
}
