import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";

const MAX_CONVERSATION_KEYS = 64;
const MAX_REVISIONS_PER_KEY = 128;
/** Thread-environment authority entries share the file; the store keeps its own 256-entry bound. */
const MAX_THREAD_ENVIRONMENTS = 256;
/** The append-only JSONL is rewritten compacted once its raw size drifts past this mark. */
const COMPACT_FILE_BYTES = 4 * 1024 * 1024;

/**
 * R3/P4: one append-only JSONL file owns every per-conversation fact the bridge used to scatter
 * across instruction-ledger.json, inline-budget.json, and thread-environments.json. The Codex
 * rollout jsonl remains the single history authority; this file only caches which instruction
 * revisions a retained browser conversation already received, its cumulative inline spend, and
 * the trusted thread-environment authority. Corruption never blocks a turn: unreadable lines are
 * skipped and the file is rebuilt compacted (损坏即重建, Cline-style).
 */
export interface ConversationRecord {
  kind: "conversation";
  key: string;
  threadId?: string;
  modelId?: string;
  reasoning?: string;
  compactionEpoch?: unknown;
  state?: "retained" | "released";
  deliveredRevisionIds?: string[];
  lastAssistantAnswerHash?: string;
  inlineSpendTokens?: number;
  updatedAt: number;
  deleted?: true;
}

export interface ThreadEnvironmentRecord {
  kind: "thread-environment";
  threadId: string;
  /** Stored authority payload; validated by ChatGptThreadEnvironmentStore on read. */
  environment?: unknown;
  updatedAt: number;
  deleted?: true;
}

export type ConversationStateRecord = ConversationRecord | ThreadEnvironmentRecord;

/** The merged file lives beside every legacy state file, derived from the existing configuration. */
export function conversationStatePath(legacyStatePath: string | undefined): string | undefined {
  if (!legacyStatePath) return undefined;
  return join(dirname(legacyStatePath), "conversations.jsonl");
}

function parseLine(line: string): ConversationStateRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as ConversationStateRecord;
    if (parsed?.kind === "conversation" && typeof parsed.key === "string") return parsed;
    if (parsed?.kind === "thread-environment" && typeof parsed.threadId === "string") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * One shared JSONL file per resolved path. Every consumer (instruction ledger, inline budget,
 * thread-environment store) receives the same instance, so concurrent appends cannot lose updates.
 */
export class ConversationStateFile {
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly threadEnvironments = new Map<string, ThreadEnvironmentRecord>();
  private loaded = false;
  private migrated = false;
  private fileBytes = 0;

  constructor(
    readonly path: string | undefined,
    private readonly legacyPaths: {
      instructionLedger?: string;
      inlineBudget?: string;
      threadEnvironment?: string;
    } = {},
  ) {}

  conversation(key: string): ConversationRecord | undefined {
    this.ensureLoaded();
    return this.conversations.get(key);
  }

  putConversation(record: Partial<Omit<ConversationRecord, "kind" | "key">> & { key: string }): void {
    this.ensureLoaded();
    const merged: ConversationRecord = {
      ...this.conversations.get(record.key),
      ...record,
      kind: "conversation",
      key: record.key,
      updatedAt: Date.now(),
    };
    if (record.deleted === true) {
      delete merged.deliveredRevisionIds;
      delete merged.inlineSpendTokens;
      delete merged.lastAssistantAnswerHash;
      merged.deleted = true;
    } else {
      // A live patch (new revisions or spend) un-deletes a tombstoned conversation.
      delete merged.deleted;
    }
    this.conversations.delete(record.key);
    this.conversations.set(record.key, merged);
    while (this.conversations.size > MAX_CONVERSATION_KEYS) {
      const oldest = [...this.conversations.values()]
        .filter(candidate => !candidate.deleted)
        .sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (!oldest) break;
      this.conversations.delete(oldest.key);
    }
    this.append(merged);
  }

  forgetConversation(key: string): void {
    this.ensureLoaded();
    const existing = this.conversations.get(key);
    if (!existing || existing.deleted) return;
    this.putConversation({ key, deleted: true, state: "released" });
  }

  threadEnvironment(threadId: string): ThreadEnvironmentRecord | undefined {
    this.ensureLoaded();
    return this.threadEnvironments.get(threadId);
  }

  threadEnvironmentIds(): string[] {
    this.ensureLoaded();
    return [...this.threadEnvironments.keys()];
  }

  putThreadEnvironment(threadId: string, environment: unknown, updatedAt = Date.now()): void {
    this.ensureLoaded();
    const record: ThreadEnvironmentRecord = {
      kind: "thread-environment",
      threadId,
      environment,
      updatedAt,
    };
    this.threadEnvironments.delete(threadId);
    this.threadEnvironments.set(threadId, record);
    while (this.threadEnvironments.size > MAX_THREAD_ENVIRONMENTS) {
      const oldest = [...this.threadEnvironments.values()]
        .filter(candidate => !candidate.deleted)
        .sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (!oldest) break;
      // Capacity eviction must tombstone as well: the append-only file still holds the evicted
      // entry, and a later load would otherwise resurrect it past the bound.
      this.threadEnvironments.delete(oldest.threadId);
      this.append({ kind: "thread-environment", threadId: oldest.threadId, updatedAt: Date.now(), deleted: true });
    }
    this.append(record);
  }

  forgetThreadEnvironment(threadId: string): void {
    this.ensureLoaded();
    const existing = this.threadEnvironments.get(threadId);
    if (!existing || existing.deleted) return;
    // Drop the live record in memory too, so same-process reads honor the tombstone and a later
    // load() cannot resurrect it from the append-only file.
    this.threadEnvironments.delete(threadId);
    this.append({ kind: "thread-environment", threadId, updatedAt: Date.now(), deleted: true });
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.path && existsSync(this.path)) {
      try {
        this.fileBytes = statSync(this.path).size;
        const raw = readFileSync(this.path, "utf8");
        for (const line of raw.split("\n")) {
          const record = parseLine(line);
          if (!record) continue;
          if (record.kind === "conversation") {
            this.conversations.delete(record.key);
            this.conversations.set(record.key, record);
          } else {
            this.threadEnvironments.delete(record.threadId);
            this.threadEnvironments.set(record.threadId, record);
          }
        }
      } catch (error) {
        // 损坏即重建: a half-written or unreadable file costs its cache, never the daemon.
        console.warn(`[chatgpt-web] conversation state file was unreadable and starts empty: ${
          error instanceof Error ? error.message : String(error)}`);
        this.conversations.clear();
        this.threadEnvironments.clear();
      }
    }
    this.migrateLegacy();
    if (this.path && this.fileBytes > COMPACT_FILE_BYTES) this.compact();
  }

  /** One-time import of the pre-merge state files; the legacy files are never written again. */
  private migrateLegacy(): void {
    if (this.migrated) return;
    this.migrated = true;
    if (!this.path || existsSync(this.path)) return;
    const imported: ConversationStateRecord[] = [];
    try {
      const ledgerPath = this.legacyPaths.instructionLedger;
      if (ledgerPath && existsSync(ledgerPath)) {
        const parsed = JSON.parse(readFileSync(ledgerPath, "utf8")) as { version?: number; keys?: Record<string, string[]> };
        for (const [key, revisions] of Object.entries(parsed.keys ?? {})) {
          if (!Array.isArray(revisions)) continue;
          imported.push({
            kind: "conversation",
            key,
            deliveredRevisionIds: revisions.filter(value => typeof value === "string").slice(-MAX_REVISIONS_PER_KEY),
            updatedAt: Date.now(),
          });
        }
      }
      const budgetPath = this.legacyPaths.inlineBudget;
      if (budgetPath && existsSync(budgetPath)) {
        const parsed = JSON.parse(readFileSync(budgetPath, "utf8")) as { version?: number; spend?: Record<string, number> };
        for (const [key, tokens] of Object.entries(parsed.spend ?? {})) {
          if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) continue;
          const existing = imported.findLast(record => record.kind === "conversation" && record.key === key);
          if (existing && existing.kind === "conversation") existing.inlineSpendTokens = tokens;
          else imported.push({ kind: "conversation", key, inlineSpendTokens: tokens, updatedAt: Date.now() });
        }
      }
      const environmentPath = this.legacyPaths.threadEnvironment;
      if (environmentPath && existsSync(environmentPath)) {
        const parsed = JSON.parse(readFileSync(environmentPath, "utf8")) as { version?: number; threads?: Record<string, unknown> };
        for (const [threadId, environment] of Object.entries(parsed.threads ?? {})) {
          imported.push({ kind: "thread-environment", threadId, environment, updatedAt: Date.now() });
        }
      }
    } catch (error) {
      console.warn(`[chatgpt-web] legacy conversation state migration was skipped: ${
        error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (imported.length === 0) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, imported.map(record => JSON.stringify(record)).join("\n") + "\n", "utf8");
      this.fileBytes = statSync(this.path).size;
      for (const record of imported) {
        if (record.kind === "conversation") {
          this.conversations.delete(record.key);
          this.conversations.set(record.key, record);
        } else {
          this.threadEnvironments.delete(record.threadId);
          this.threadEnvironments.set(record.threadId, record);
        }
      }
      console.warn(`[chatgpt-web] migrated ${imported.length} legacy state records into ${this.path}`);
    } catch (error) {
      console.warn(`[chatgpt-web] failed to write the migrated conversation state: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  }

  private append(record: ConversationStateRecord): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const line = `${JSON.stringify(record)}\n`;
      appendFileSync(this.path, line, "utf8");
      this.fileBytes += line.length;
      if (this.fileBytes > COMPACT_FILE_BYTES) this.compact();
    } catch (error) {
      console.warn(`[chatgpt-web] failed to persist conversation state: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Rewrite the file with only the live records, dropping tombstones and superseded history. */
  private compact(): void {
    if (!this.path) return;
    const live: ConversationStateRecord[] = [
      ...[...this.conversations.values()].filter(record => !record.deleted),
      ...[...this.threadEnvironments.values()].filter(record => !record.deleted),
    ];
    try {
      const body = live.map(record => JSON.stringify(record)).join("\n") + (live.length > 0 ? "\n" : "");
      writeFileSync(this.path, body, "utf8");
      this.fileBytes = Buffer.byteLength(body, "utf8");
    } catch (error) {
      console.warn(`[chatgpt-web] failed to compact the conversation state file: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const sharedFiles = new Map<string, ConversationStateFile>();

/** Memoized per resolved path: every consumer of one conversations.jsonl shares one instance. */
export function sharedConversationStateFile(
  path: string | undefined,
  legacyPaths: ConversationStateFile["legacyPaths"] = {},
): ConversationStateFile {
  if (!path) return new ConversationStateFile(undefined, legacyPaths);
  const existing = sharedFiles.get(path);
  if (existing) return existing;
  const created = new ConversationStateFile(path, legacyPaths);
  sharedFiles.set(path, created);
  return created;
}

/**
 * The per-conversation facade the adapter consumes: which instruction revisions a retained
 * browser conversation already received (resume vs edited-resubmit) and its cumulative inline
 * spend (the measured composer boundary). Both ride the single conversations.jsonl file.
 */
export class ChatGptConversationState {
  constructor(private readonly file: ConversationStateFile) {}

  /** Whether this exact instruction content already reached the retained conversation. */
  delivered(conversationKey: string, revisionId: string): boolean {
    return this.file.conversation(conversationKey)?.deliveredRevisionIds?.includes(revisionId) === true;
  }

  deliveredAny(conversationKey: string): boolean {
    return (this.file.conversation(conversationKey)?.deliveredRevisionIds?.length ?? 0) > 0;
  }

  record(conversationKey: string, revisionIds: readonly string[]): void {
    if (revisionIds.length === 0) return;
    const existing = this.file.conversation(conversationKey);
    const merged = [...new Set([
      ...(existing?.deleted ? [] : existing?.deliveredRevisionIds ?? []),
      ...revisionIds,
    ])].slice(-MAX_REVISIONS_PER_KEY);
    this.file.putConversation({ key: conversationKey, deliveredRevisionIds: merged, state: "retained" });
  }

  /** The conversation was released or reseeded; its delivered-instruction record is void. */
  forget(conversationKey: string): void {
    this.file.forgetConversation(conversationKey);
  }

  /**
   * Stamp the per-conversation identity (§4.6 schema): the Codex thread, browser model, reasoning
   * effort, and compaction epoch that own this conversation key.
   */
  annotate(
    conversationKey: string,
    identity: {
      threadId?: string;
      modelId?: string;
      reasoning?: string;
      compactionEpoch?: unknown;
    },
  ): void {
    this.file.putConversation({ key: conversationKey, ...identity });
  }

  /** Inline tokens already recorded for this conversation; undefined when never tracked. */
  spent(conversationKey: string): number | undefined {
    const tokens = this.file.conversation(conversationKey)?.inlineSpendTokens;
    return typeof tokens === "number" && tokens > 0 ? tokens : undefined;
  }

  recordInlineSpend(conversationKey: string, tokens: number): void {
    if (!(tokens > 0)) return;
    const existing = this.file.conversation(conversationKey);
    const next = (existing?.deleted ? 0 : existing?.inlineSpendTokens ?? 0) + tokens;
    this.file.putConversation({ key: conversationKey, inlineSpendTokens: next, state: "retained" });
  }
}