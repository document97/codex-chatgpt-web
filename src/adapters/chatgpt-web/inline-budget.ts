import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_KEYS = 64;

/**
 * Persists how many inline tokens each retained browser conversation has already received. The
 * launcher keeps the Temporary Chat alive across daemon restarts while this spend was previously
 * tracked only in memory, so a restarted daemon would stage fresh inline bulk into a conversation
 * that had already spent its measured cumulative budget and get it rejected as too long. The
 * spend is recorded optimistically at compile time, which only ever forces attachments.
 */
export class ChatGptInlineBudgetLedger {
  private readonly spend = new Map<string, number>();

  constructor(private readonly statePath: string | undefined) {
    if (!statePath) return;
    try {
      if (!existsSync(statePath)) return;
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { version?: number; spend?: Record<string, number> };
      if (parsed?.version !== 1 || typeof parsed.spend !== "object" || parsed.spend === null) return;
      for (const [key, tokens] of Object.entries(parsed.spend)) {
        if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) this.spend.set(key, tokens);
      }
    } catch (error) {
      console.warn(`[chatgpt-web] inline budget ledger was unreadable and starts empty: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Inline tokens already recorded for this conversation; undefined when never tracked. */
  spent(conversationKey: string): number | undefined {
    return this.spend.get(conversationKey);
  }

  record(conversationKey: string, tokens: number): void {
    if (!(tokens > 0)) return;
    const next = (this.spend.get(conversationKey) ?? 0) + tokens;
    this.spend.delete(conversationKey);
    this.spend.set(conversationKey, next);
    while (this.spend.size > MAX_KEYS) {
      const oldest = this.spend.keys().next().value;
      if (oldest === undefined) break;
      this.spend.delete(oldest);
    }
    this.persist();
  }

  /** The conversation was released or reseeded; its recorded spend is void. */
  forget(conversationKey: string): void {
    if (!this.spend.has(conversationKey)) return;
    this.spend.delete(conversationKey);
    this.persist();
  }

  private persist(): void {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify({ version: 1, spend: Object.fromEntries([...this.spend.entries()]) }), "utf8");
    } catch (error) {
      console.warn(`[chatgpt-web] failed to persist the inline budget ledger: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  }
}
