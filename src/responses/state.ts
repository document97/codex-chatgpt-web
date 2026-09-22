import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { replayCodexRolloutResponseItems } from "../adapters/chatgpt-web/codex-rollout-environment";

const MAX_STORED_RESPONSES = 1_000;
/** P4/R3: the cache is a rebuildable single-turn expansion buffer, not durable history. */
const RESPONSE_TTL_MS = 30 * 60 * 1_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
/**
 * Chain storage (parent reference + suffix) keeps the per-turn cost linear instead of the old
 * ~quadratic full-expanded copies, so 8MB bounds far more chains than the previous 64MB did.
 */
const MAX_STORED_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Entries whose serialized size exceeds this are kept in memory but skipped on disk: inputs can
 * carry base64 `input_image` data URLs, and one screenshot-heavy thread must not balloon the file. */
const SNAPSHOT_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_MAX_BYTES = 4 * 1024 * 1024;

interface StoredResponseState {
  createdAt: number;
  /**
   * Chain head entries store the full expanded list; chained entries store only the suffix they
   * appended to `parentId`, so a long previous_response_id chain costs linear bytes.
   */
  items?: unknown[];
  parentId?: string;
  suffix?: unknown[];
  /** Approximate in-memory size, computed locally at insert time (never trusted from disk). */
  sizeBytes?: number;
}

const states = new Map<string, StoredResponseState>();
let storedResponseBytes = 0;

/** The ONLY size computation: approximate entry weight from its stored payload. */
function measuredEntry(entry: Omit<StoredResponseState, "sizeBytes">): StoredResponseState {
  let sizeBytes = 0;
  try {
    sizeBytes = JSON.stringify(entry.items ?? entry.suffix ?? entry.parentId ?? []).length;
  } catch {
    /* unserializable items: weightless rather than fatal */
  }
  return { ...entry, sizeBytes };
}

/** Resolve a chain entry to its full expanded list; undefined when a link is missing. */
function resolveItems(entry: StoredResponseState): unknown[] | undefined {
  if (Array.isArray(entry.items)) return entry.items;
  if (typeof entry.parentId !== "string" || !Array.isArray(entry.suffix)) return undefined;
  const visited = new Set<string>([entry.parentId]);
  const segments: unknown[][] = [entry.suffix];
  let cursor = entry.parentId;
  for (;;) {
    const parent = states.get(cursor);
    if (!parent) return undefined;
    if (Array.isArray(parent.items)) {
      segments.unshift(parent.items);
      break;
    }
    if (typeof parent.parentId !== "string" || !Array.isArray(parent.suffix) || visited.has(parent.parentId)) {
      return undefined;
    }
    visited.add(parent.parentId);
    segments.unshift(parent.suffix);
    cursor = parent.parentId;
  }
  return segments.flat();
}

/** The ONLY insertion point: keeps the byte counter consistent on replacement. */
function setEntry(id: string, entry: Omit<StoredResponseState, "sizeBytes">): void {
  deleteEntry(id);
  const measured = measuredEntry(entry);
  storedResponseBytes += measured.sizeBytes ?? 0;
  states.set(id, measured);
}

/** The ONLY deletion point: TTL, count, byte, and explicit deletes all route here. */
function deleteEntry(id: string): void {
  const existing = states.get(id);
  if (!existing) return;
  storedResponseBytes -= existing.sizeBytes ?? 0;
  if (storedResponseBytes < 0) storedResponseBytes = 0;
  states.delete(id);
}
// Expansion provenance must stay proxy-private: a WeakMap distinguishes replayed history from the
// newly appended input suffix without adding an unknown field that native passthrough could send
// upstream. Consumers use the prefix length to bind trusted history and rolling checkpoints to the
// exact replayed portion of this request.
const replayedInputPrefixLengths = new WeakMap<object, number>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistPath: string | null = null;

function now(): number {
  return Date.now();
}

function snapshotPath(): string {
  return join(getConfigDir(), "responses-state.json");
}

/**
 * Best-effort disk snapshot so previous_response_id chains survive a proxy restart (the
 * dominant expansion-miss cause: an in-memory-only store dies with the process, and the next
 * chained turn then reaches the upstream as a naked delta). Load is lazy on first store access;
 * persistence is debounced + unref'd so the hot path never blocks and the process can exit.
 * Every disk failure is swallowed — the snapshot is a cache, not a source of truth.
 */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const path = snapshotPath();
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; states?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.states)) return;
    for (const entry of raw.states) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, state] = entry as [unknown, unknown];
      if (typeof id !== "string" || !state || typeof state !== "object") continue;
      const rec = state as StoredResponseState;
      if (typeof rec.createdAt !== "number" || (!Array.isArray(rec.items) && !Array.isArray(rec.suffix))) continue;
      // Recompute sizes locally while loading; persisted sizeBytes is never trusted.
      setEntry(id, {
        createdAt: rec.createdAt,
        ...(Array.isArray(rec.items) ? { items: rec.items } : {}),
        ...(typeof rec.parentId === "string" ? { parentId: rec.parentId } : {}),
        ...(Array.isArray(rec.suffix) ? { suffix: rec.suffix } : {}),
      });
    }
    pruneResponses();
  } catch {
    /* missing/corrupt snapshot: start empty */
  }
}

function persistNow(path: string): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersistPath = null;
  try {
    const entries: [string, StoredResponseState][] = [];
    let total = 0;
    // Newest-first so the most recent chains survive both caps.
    for (const entry of [...states].reverse()) {
      // sizeBytes is in-memory accounting only; keep it out of the disk snapshot.
      const [id, state] = entry;
      const { sizeBytes: _sizeBytes, ...persistable } = state;
      const persistEntry: [string, StoredResponseState] = [id, persistable];
      const size = JSON.stringify(persistEntry).length;
      if (size > SNAPSHOT_ENTRY_MAX_BYTES) continue;
      if (total + size > SNAPSHOT_TOTAL_MAX_BYTES) break;
      total += size;
      entries.push(persistEntry);
    }
    entries.reverse();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // mkdirSync's mode only applies on creation — re-harden an existing config dir so the
    // conversation-content snapshot never lands in a group/world-readable directory.
    try { chmodSync(dirname(path), 0o700); } catch { /* best-effort (e.g. Windows) */ }
    atomicWriteFile(path, JSON.stringify({ version: 1, states: entries }));
  } catch {
    /* best-effort: disk trouble must never affect request handling */
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  // Resolve the target path now: tests may swap CODEX_CHATGPT_WEB_HOME before the
  // debounce fires, and a late write must land in the home that owned the recorded state.
  pendingPersistPath = snapshotPath();
  const path = pendingPersistPath;
  persistTimer = setTimeout(() => persistNow(path), SNAPSHOT_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

/** Flush any pending debounced snapshot write (graceful shutdown / deterministic tests). */
export function flushResponseState(): void {
  if (!persistTimer) return;
  // Use the path captured when the write was scheduled; CODEX_CHATGPT_WEB_HOME may have moved.
  persistNow(pendingPersistPath ?? snapshotPath());
}

function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  return [input];
}

function pruneResponses(at = now()): void {
  // Chain ancestors may not be pruned while a surviving entry still references them as its
  // parent; deleting them would strand the whole chain.
  const referencedAncestors = (): Set<string> => {
    const referenced = new Set<string>();
    for (const state of states.values()) {
      if (typeof state.parentId === "string") referenced.add(state.parentId);
    }
    return referenced;
  };
  for (const [id, state] of states) {
    if (at - state.createdAt > RESPONSE_TTL_MS && !referencedAncestors().has(id)) deleteEntry(id);
  }
  // Count eviction, oldest-first (Map preserves insertion order). A referenced ancestor rotates
  // to the tail so a child leaves first; a pathological chain longer than the whole store would
  // rotate forever, so a full rotation without progress breaks its oldest link instead of hanging.
  let rotated = 0;
  while (states.size > MAX_STORED_RESPONSES) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    if (rotated >= states.size) {
      deleteEntry(oldest);
      break;
    }
    if (referencedAncestors().has(oldest)) {
      const entry = states.get(oldest)!;
      states.delete(oldest);
      states.set(oldest, entry);
      rotated += 1;
      continue;
    }
    rotated = 0;
    deleteEntry(oldest);
  }
  // Byte high-water eviction, oldest-first.
  rotated = 0;
  while (storedResponseBytes > MAX_STORED_RESPONSE_BYTES && states.size > 1) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    if (rotated >= states.size) {
      deleteEntry(oldest);
      break;
    }
    if (referencedAncestors().has(oldest)) {
      const entry = states.get(oldest)!;
      states.delete(oldest);
      states.set(oldest, entry);
      rotated += 1;
      continue;
    }
    rotated = 0;
    deleteEntry(oldest);
  }
}

function clientMetadataThreadId(body: Record<string, unknown>): string | undefined {
  const metadata = body.client_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const raw = (metadata as Record<string, unknown>)["x-codex-turn-metadata"];
  const parsed = typeof raw === "string" ? safeJsonRecord(raw) : recordObject(raw);
  const threadId = parsed?.thread_id;
  return typeof threadId === "string" ? threadId : undefined;
}

function safeJsonRecord(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return recordObject(parsed);
  } catch {
    return undefined;
  }
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Remove the request's own trailing input items from a replayed rollout history, so the expansion
 * is exactly the trusted prefix. Declines (undefined) unless the tail matches item-for-item.
 */
function stripTrailingItems(history: unknown[], delta: unknown[]): unknown[] | undefined {
  if (delta.length === 0) return [...history];
  if (history.length < delta.length) return undefined;
  for (let offset = 0; offset < delta.length; offset += 1) {
    const historyItem = history[history.length - delta.length + offset];
    try {
      if (JSON.stringify(historyItem) !== JSON.stringify(delta[offset])) return undefined;
    } catch {
      return undefined;
    }
  }
  return history.slice(0, history.length - delta.length);
}

/**
 * P4/R3: when the short-lived expansion cache misses a previous_response_id, rebuild the prefix
 * from the thread's own rollout jsonl instead of sending the naked delta upstream. The replay is
 * applied only when the current request's input visibly tails the rollout items; otherwise the
 * body is returned unchanged exactly as before.
 */
function expandFromRolloutReplay(request: Record<string, unknown>): Record<string, unknown> | undefined {
  const threadId = clientMetadataThreadId(request);
  if (!threadId) return undefined;
  let replayed: unknown[] | undefined;
  try {
    replayed = replayCodexRolloutResponseItems({ threadId });
  } catch {
    return undefined;
  }
  if (!replayed || replayed.length === 0) return undefined;
  const delta = inputItems(request.input);
  if (delta.length >= replayed.length) return undefined;
  const prefix = stripTrailingItems(replayed, delta);
  if (!prefix || prefix.length === 0) return undefined;
  return { ...request, input: [...prefix, ...delta] };
}

export function expandPreviousResponseInput(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  if (!previousId) return body;
  ensureLoaded();
  pruneResponses();
  const previous = states.get(previousId);
  if (previous) {
    const items = resolveItems(previous);
    if (items) {
      const expanded = {
        ...request,
        input: [...items, ...inputItems(request.input)],
      };
      replayedInputPrefixLengths.set(expanded, items.length);
      return expanded;
    }
  }
  const replayed = expandFromRolloutReplay(request);
  if (!replayed) return body;
  replayedInputPrefixLengths.set(replayed, (replayed.input as unknown[]).length - inputItems(request.input).length);
  return replayed;
}

/** Number of leading input items restored from previous_response_id state for this exact body. */
export function previousResponseReplayPrefixLength(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  return replayedInputPrefixLengths.get(body) ?? 0;
}

/**
 * Cache completed output and max_output_tokens partial output for previous_response_id replay.
 * Content-filtered incomplete and failed output are not authoritative replay history.
 */
export function rememberResponseState(
  requestBody: unknown,
  response: { id?: unknown; output?: unknown; status?: unknown; incomplete_details?: unknown },
  opts?: { force?: boolean },
): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
  // `force` bypasses only the store:false skip: Codex sends `store:false` on every non-Azure
  // HTTP request (and WS inherits it), yet its WS turns still chain with previous_response_id.
  // The passthrough branch records with force so those chains can be expanded locally; the
  // store stays in-memory with a 30min TTL, so this is a proxy-internal continuation cache, not
  // real server-side response storage.
  if (request.store === false && !opts?.force) return;
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status === "incomplete") {
    const details = response.incomplete_details;
    if (!details || typeof details !== "object" || Array.isArray(details)
      || (details as { reason?: unknown }).reason !== "max_output_tokens") return;
  } else if (response.status !== undefined && response.status !== "completed") return;
  ensureLoaded();
  // P4/R3: chain storage kills the old quadratic full-copy growth. When this request continued
  // a cached previous_response_id, only the new suffix rides this entry; otherwise it stores
  // the whole expanded list as the chain head.
  const parentResponseId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  if (parentResponseId !== undefined && states.get(parentResponseId)) {
    setEntry(response.id, {
      createdAt: now(),
      parentId: parentResponseId,
      suffix: [...inputItems(request.input), ...response.output],
    });
  } else {
    setEntry(response.id, {
      createdAt: now(),
      items: [...inputItems(request.input), ...response.output],
    });
  }
  pruneResponses();
  schedulePersist();
}
