import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { CHATGPT_WEB_INLINE_CONVERSATION_TOKEN_LIMIT, isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { estimateTokens } from "../../lib/token-estimate";
import { defaultBrokerEndpoint, expandUserPath, resolveBrokerEndpoint } from "../../config";
import {
  cancelLauncherManualTurn,
  endLauncherManualTurn,
  LauncherBrowserTurnCancelledError,
  LauncherManualTurnFailedError,
  LauncherManualTurnTimedOutError,
  markLauncherManualTurnStarted,
  releaseLauncherRetainedConversation,
  startLauncherManualTurn,
  waitForLauncherManualSent,
  waitForLauncherManualTerminal,
  type LauncherManualTurnEnd,
  type LauncherManualTurnOwner,
  type LauncherManualTurnStart,
} from "../../launcher-browser-host";
import { namespacedToolName, type AdapterEvent, type CodexContentPart, type CodexParsedRequest, type CodexProviderConfig, type CodexToolResultMessage, type CodexUsage } from "../../types";
import type { ProviderAdapter } from "../base";
import { parseDataUrl } from "../image";
import { ChatGptWebAdapterError } from "./adapter-error";
import { ChatGptBrowserWorker } from "./browser-worker";
import {
  chatGptTurnUserRevisionHistory,
  chatGptTurnUserRevisionId,
  extractChatGptTurnEnvironment,
  extractChatGptTurnIdentity,
  priorChatGptAbortedTurnIds,
} from "./environment";
import { ChatGptRetainedInstructionLedger } from "./instruction-ledger";
import { ChatGptInlineBudgetLedger } from "./inline-budget";
import { compiledChatGptWebMessages } from "./input-tokens";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { CHATGPT_WEB_CONNECTOR_DISCOVERY_CONTRACT, CHATGPT_WEB_CONTEXT_BUDGET_INSTRUCTION, chatGptLatestUserRequestLines, chatGptLatestUserRequestText, chatGptReadOnlyContextWarning, compileChatGptWebPrompt } from "./prompt";
import { createChatGptStructuredOutputValidator } from "./output-validation";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { TurnBroker, type BrokerToolRequest, type BrokerToolResult, type TurnBrokerOwner } from "./turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptInstructionLineage, chatGptThreadOwnershipKey, chatGptTurnExecutionKey, chatGptTurnRetryKey, chatGptTurnRoundKey, chatGptTurnSessions, type ChatGptBrowserOutcome, type ChatGptTraceEvent, type ChatGptTurnRuntime, type ChatGptTurnSession } from "./turn-execution";
import { chatGptWebContextYieldTokenLimit, estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import {
  ChatGptLunaCheckpointStore,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import { ChatGptExternalTurnProgress } from "./turn-progress";
import {
  canonicalizeCompactionHandoff,
  existingStructuredCompactionRun,
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
  settleActiveZeroRiskCompactionSource,
} from "./compaction-handoff";
import {
  chatGptConversationKey,
  retainedConversationResumeRequest,
} from "./conversation-key";

function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.chatgptWeb?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof ChatGptWebAdapterError) return signal.reason;
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

function cancellableBrowserTurn(
  run: Promise<string>,
  controller: AbortController,
): { browser: Promise<string>; physicalSettlement: Promise<void>; cancel: (reason?: Error) => void } {
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  let cancellationRejected = false;
  return {
    // Cancellation wins immediately even while the detached Playwright helper is still unwinding.
    // The helper keeps the same abort signal and remains responsible for its normal end/cleanup
    // handshake, but the Codex Responses turn no longer waits on that process cleanup.
    browser: Promise.race([run, cancellation]),
    // `browser` is the fast client-facing result. Replacement ownership must wait for the actual
    // worker promise, whose finally block completes the launcher /turn/end handshake.
    physicalSettlement: run.then(() => undefined, () => undefined),
    cancel(reason?: Error) {
      if (!controller.signal.aborted) controller.abort(reason);
      // Explicit targeted cancellation ends the Codex Responses turn immediately. Generic
      // retirement (client disconnect or compaction replacement) still waits for the helper's
      // cleanup handshake before a replacement browser may start.
      if (reason && !cancellationRejected) {
        cancellationRejected = true;
        rejectCancellation(reason);
      }
    },
  };
}

export interface ChatGptZeroRiskManualControl {
  start(descriptorPath: string, activity: LauncherManualTurnStart): Promise<unknown>;
  waitSent(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
  waitTerminal(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ status: "cancelled" | "failed" }>;
  markStarted(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
  end(descriptorPath: string, activity: LauncherManualTurnEnd): Promise<unknown>;
  cancel(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
}

const launcherZeroRiskManualControl: ChatGptZeroRiskManualControl = {
  start: startLauncherManualTurn,
  waitSent: waitForLauncherManualSent,
  waitTerminal: waitForLauncherManualTerminal,
  markStarted: markLauncherManualTurnStarted,
  end: endLauncherManualTurn,
  cancel: cancelLauncherManualTurn,
};

function safeManualAdapterError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  if (error instanceof ChatGptWebAdapterError) return error;
  if (error instanceof LauncherManualTurnTimedOutError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 408,
      errorType: "invalid_request_error",
      code: "manual_handoff_timeout",
      retryable: false,
    });
  }
  if (error instanceof LauncherBrowserTurnCancelledError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  if (error instanceof LauncherManualTurnFailedError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 502,
      errorType: "server_error",
      code: "manual_launcher_failed",
      retryable: false,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function safeManualTerminalError(status: "cancelled" | "failed"): ChatGptWebAdapterError {
  if (status === "cancelled") {
    return new ChatGptWebAdapterError("The Zero Risk browser turn was cancelled in the Launcher", {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  return new ChatGptWebAdapterError("The Zero Risk browser tab failed before ChatGPT completed the turn", {
    status: 502,
    errorType: "server_error",
    code: "manual_launcher_failed",
    retryable: false,
  });
}

export function chatGptWebExecutionNamespace(provider: CodexProviderConfig): string {
  return createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    chatgptWeb: provider.chatgptWeb ?? {},
  })).digest("hex");
}

export function chatGptWebTraceId(provider: CodexProviderConfig, parsed: CodexParsedRequest): string {
  const namespace = chatGptWebExecutionNamespace(provider);
  // The logical response key survives compaction so a final answer that won the handoff race
  // can still be replayed. A new physical browser owner must instead belong to the new context
  // epoch; otherwise Zero Risk correctly rejects it against the previous owner's completion.
  const conversation = parsed._compactionRequest ? undefined : chatGptConversationKey(parsed, namespace);
  return createHash("sha256")
    .update(`${namespace}:${chatGptTurnExecutionKey(parsed)}`)
    .update(conversation ? `:${conversation}` : "")
    .digest("hex")
    .slice(0, 12);
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "file") return { type: "text", text: `[file attachment: ${part.filename ?? part.fileId ?? "unnamed"}]` };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function toolResultText(message: CodexToolResultMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
}

function brokerResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = toolResultText(message);
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

function emitBrowserCompletion(outcome: ChatGptBrowserOutcome, usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  if (outcome.type === "error") throw outcome.error;
  emit({ type: "done", stopReason: "stop", endTurn: true, usage });
}

function emitTraceEvents(trace: ChatGptTraceEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: event.text });
    }
  }
}

function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

function emitReadOnlyContextWarning(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

function submittedTurnFailure(session: ChatGptTurnSession, error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (normalized instanceof ChatGptWebAdapterError) return normalized;
  const phase = session.runtime.submission?.phase;
  if (!phase || phase === "prepared") return normalized;
  const ambiguous = phase === "send_activated";
  return new ChatGptWebAdapterError(
    ambiguous
      ? "ChatGPT did not confirm that the prompt was sent. Check the ChatGPT tab before continuing."
      : "ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.",
    {
      status: 502,
      errorType: "server_error",
      code: ambiguous ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed",
      retryable: false,
      cause: normalized,
    },
  );
}

function currentToolResults(parsed: CodexParsedRequest, session: ChatGptTurnSession): CodexToolResultMessage[] {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return [...byId.values()];
}

function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}

/** Keep the Responses bridge alive during every awaited phase of a browser turn. */
export const CHATGPT_WEB_ADAPTER_HEARTBEAT_MS = 10_000;
export const CHATGPT_WEB_MAX_COMPLETION_RECOVERY_ROUNDS = 3;

function explicitCompletionRecoveryPrompt(
  turnToken: string,
  previousText?: string,
  contextBudgetExhausted = false,
  latestUserRequest?: string,
): string {
  // Assistant-side prefill is not available on the ChatGPT surface; quoting the model's own
  // closing text into the continuation request reproduces the prefill's pull into mid-task mode.
  const quoted = previousText?.replace(/\s+/g, " ").trim().slice(-280);
  return [
    quoted
      ? `Your previous response ended with: "${quoted}". Continue from exactly where that left off.`
      : "The immediately preceding Codex response ended without the required terminal handoff.",
    CHATGPT_WEB_CONNECTOR_DISCOVERY_CONTRACT,
    ...(contextBudgetExhausted
      ? [CHATGPT_WEB_CONTEXT_BUDGET_INSTRUCTION]
      : [
        "Do not restart or repeat completed work. Review the existing conversation and tool results.",
        "If the quoted text or your own plan names work still to do, perform the next action now with the available Codex tools and verify the result; do not restate plans or report status instead of acting.",
        "When all requested work is complete, call codex_turn_complete exactly once with the complete user-facing final answer.",
      ]),
    "Do not reply with an ordinary progress message. The terminal tool is required. Repeating your previous answer as plain text is not a valid outcome.",
    `Pass turn_token ${turnToken} unchanged to every Codex Native call in this response and do not expose it in the answer.`,
    // R1: a bare nudge is forbidden — every recovery round re-anchors the verbatim latest human
    // request at the end of the visible message, so a retained conversation never drifts back to
    // stale instructions buried in its history.
    ...(latestUserRequest === undefined ? [] : chatGptLatestUserRequestLines(latestUserRequest)),
  ].join("\n");
}

const normalizeTurnText = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * A Codex resume can replay the exact canonical history with no new user content at all. The
 * retained conversation already owns that history, so it receives only this nudge; the compile's
 * own transport contract supplies the tool and completion rules around it.
 */
const CHATGPT_WEB_RESUME_NUDGE =
  "The user resumed this Codex task. Continue the unfinished work from this conversation's existing context: perform the next required action now with the attached Codex tools. Do not restart completed work and do not reply with a progress report instead of acting.";

function resumeNudgeRequest(parsed: CodexParsedRequest): CodexParsedRequest {
  return {
    ...parsed,
    context: {
      ...parsed.context,
      messages: [{ role: "user", content: CHATGPT_WEB_RESUME_NUDGE, timestamp: Date.now() }],
    },
  };
}

/**
 * Whether the history Codex will replay for the next request has already spent the room a further
 * tool round needs. The bridge cannot shrink that history — Codex owns it — so the only available
 * action is to stop extending the turn and ask for a resumable handoff instead.
 */
function contextBudgetExhausted(
  usageInput: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  experimentalBiggerContext: boolean | undefined,
  pendingResultTokens = 0,
): boolean {
  const yieldAtTokens = chatGptWebContextYieldTokenLimit(
    usageInput, capabilities, experimentalBiggerContext === true,
  );
  return yieldAtTokens !== undefined
    && estimateChatGptWebUsage(usageInput, {}, capabilities, experimentalBiggerContext).inputTokens
      + pendingResultTokens >= yieldAtTokens;
}

// A continuation round that reproduces the previous round's text means the model is idling:
// further rounds would burn the same tokens. The auto-completion fallback decides the outcome.
function isRepeatedStatus(previous: string, current: string): boolean {
  const left = normalizeTurnText(previous);
  const right = normalizeTurnText(current);
  if (!left || !right) return false;
  if (left === right) return true;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  if (leftTokens.size < 8 || rightTokens.size < 8) return false;
  let shared = 0;
  for (const token of rightTokens) if (leftTokens.has(token)) shared += 1;
  return shared / Math.min(leftTokens.size, rightTokens.size) >= 0.85;
}

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: {
    broker?: TurnBrokerOwner;
    zeroRiskManualControl?: ChatGptZeroRiskManualControl;
  } = {},
): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = dependencies.broker ?? TurnBroker.forSocket(brokerSocketPath(provider));
  const zeroRiskManualControl = dependencies.zeroRiskManualControl ?? launcherZeroRiskManualControl;
  const structuredBroker = broker instanceof TurnBroker ? broker : undefined;
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs;
  const experimentalBiggerContext = provider.chatgptWeb?.experimentalBiggerContext;
  if (experimentalBiggerContext !== undefined && typeof experimentalBiggerContext !== "boolean") {
    throw new Error("ChatGPT Bigger Context preference must be a boolean");
  }
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    extraHighAvailable: provider.chatgptWeb?.extraHighAvailable === true,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
    // The model catalog already advertises the multiplied window to Codex; the browser preflight
    // reads the same flag from capabilities, so a whole-context attachment turn estimated above
    // the base window must be judged against the window Codex actually believes it has.
    ...(experimentalBiggerContext === true ? { experimentalBiggerContext: true } : {}),
  };
  const explicitCompletionRequired = provider.chatgptWeb?.explicitCompletion === true;
  const manualInteraction = provider.chatgptWeb?.browserInteractionMode === "manual";
  const transcriptTransport = provider.chatgptWeb?.transcriptTransport === true;
  const executionNamespace = chatGptWebExecutionNamespace(provider);
  const retainedLauncherDescriptor = provider.chatgptWeb?.browserHost === "launcher"
    && provider.chatgptWeb.browserHostDescriptorPath
      ? resolve(expandUserPath(provider.chatgptWeb.browserHostDescriptorPath))
      : undefined;
  /**
   * Inline tokens already spent per retained browser conversation, persisted so a restarted
   * daemon does not restage fresh inline bulk into a Temporary Chat the launcher kept alive.
   * ChatGPT's composer boundary is cumulative per conversation; once the allowance is spent,
   * bulk content travels as a generated attachment instead. Accounting is recorded optimistically
   * at compile time, which only ever forces attachments.
   */
  const inlineBudget = new ChatGptInlineBudgetLedger(
    provider.chatgptWeb?.inlineBudgetStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.inlineBudgetStatePath))
      : undefined,
  );
  const remainingInlineTokens = (conversationKey: string): number | undefined => {
    const sent = inlineBudget.spent(conversationKey);
    return sent === undefined
      ? undefined
      : Math.max(0, CHATGPT_WEB_INLINE_CONVERSATION_TOKEN_LIMIT - sent);
  };
  /**
   * ChatGPT's too-long rejection proves this browser conversation already spent its cumulative
   * inline budget — including spend this process never observed (a ledger restored empty under a
   * Temporary Chat the launcher kept alive). Mark it spent out so every later compile rides the
   * attachment transport, and release the loaded conversation so the next turn seeds a fresh one.
   */
  const healOverspentConversation = async (error: unknown, conversationKey: string | undefined): Promise<void> => {
    if (conversationKey === undefined) return;
    if (!(error instanceof ChatGptWebAdapterError) || error.code !== "context_length_exceeded"
      || !error.message.startsWith("ChatGPT rejected this browser message as too long")) return;
    inlineBudget.record(conversationKey, CHATGPT_WEB_INLINE_CONVERSATION_TOKEN_LIMIT);
    if (retainedLauncherDescriptor) {
      await releaseLauncherRetainedConversation(retainedLauncherDescriptor, conversationKey).catch(() => undefined);
    }
    console.warn(`[chatgpt-web] browser conversation ${conversationKey.slice(0, 8)} was rejected as too long; marked spent and released so the retry rides a fresh attachment-transport conversation`);
  };
  const instructionLedger = new ChatGptRetainedInstructionLedger(
    provider.chatgptWeb?.instructionLedgerStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.instructionLedgerStatePath))
      : undefined,
  );
  if (manualInteraction) {
    if (!configuredCapabilities.localToolsEnabled) {
      throw new Error("ChatGPT Zero Risk requires the Full Codex harness");
    }
    if (!retainedLauncherDescriptor) {
      throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
    }
  }
  const environmentStore = new ChatGptThreadEnvironmentStore(
    provider.chatgptWeb?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
      : undefined,
  );
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(
    provider.chatgptWeb?.lunaCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))
      : undefined,
  );
  const currentUsageInput = (parsed: CodexParsedRequest): CodexParsedRequest => (
    parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !parsed._compactionRequest
      ? lunaCheckpointStore.apply(parsed).parsed
      : parsed
  );

  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
    hooks: { onCompactionProgress?: () => void } = {},
  ): ChatGptTurnRuntime => {
    const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
    if (manualRequest !== manualInteraction) {
      throw new Error(
        manualInteraction
          ? "ChatGPT Zero Risk requires the Zero Risk Web model route"
          : "The Zero Risk Web model route requires ChatGPT Zero Risk interaction mode",
      );
    }
    const mode = manualRequest
      ? { localTools: true }
      : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const identity = extractChatGptTurnIdentity(parsed);
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !parsed._compactionRequest
      && Boolean(identity.threadId && identity.turnId);
    const checkpointInput = captureLunaCheckpoint
      ? lunaCheckpointStore.apply(parsed)
      : { parsed, applied: false };
    const conversationKey = !parsed._compactionRequest
      && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
      && mode.localTools
      && retainedLauncherDescriptor
      ? chatGptConversationKey(checkpointInput.parsed, executionNamespace)
      : undefined;
    // Classify an older-turn instruction against what its browser conversation already carried
    // (ChatGptRetainedInstructionLedger): proven delivery is a Codex resume and continues the
    // retained conversation; unproven delivery is an edited resubmit and seeds a fresh
    // conversation from the full canonical history after releasing the stale one.
    const latestRevision = conversationKey !== undefined
      ? chatGptTurnUserRevisionHistory(checkpointInput.parsed).at(-1)
      : undefined;
    const revisionAlreadyDelivered = conversationKey === undefined
      || latestRevision === undefined
      || latestRevision.turnId === undefined
      || latestRevision.turnId === identity.turnId
      || instructionLedger.delivered(conversationKey, chatGptTurnUserRevisionId(latestRevision));
    const editedResubmit = !revisionAlreadyDelivered;
    const resumeInput = conversationKey && !editedResubmit
      ? retainedConversationResumeRequest(checkpointInput.parsed)
      : undefined;
    // A resumed task whose canonical history ends at the last assistant reply supplies no new
    // suffix; the retained conversation owns that history, so continue it with an explicit
    // resume nudge instead of replaying the full history into it.
    const resumeNudgeInput = conversationKey !== undefined && !editedResubmit
      && latestRevision !== undefined
      && latestRevision.turnId !== undefined
      && latestRevision.turnId !== identity.turnId
      && resumeInput === undefined
      ? resumeNudgeRequest(checkpointInput.parsed)
      : undefined;
    const retainConversation = conversationKey !== undefined;
    const releaseRetainedConversation = conversationKey && retainedLauncherDescriptor
      ? async () => {
        await releaseLauncherRetainedConversation(retainedLauncherDescriptor, conversationKey);
      }
      : undefined;
    const compileOptionsFor = (input: CodexParsedRequest) => {
      if (manualRequest) return {};
      const inlineRemaining = conversationKey !== undefined
        ? remainingInlineTokens(conversationKey)
        : undefined;
      const experimentalMultipartParts = experimentalBiggerContext
        ? resolveBiggerContextMultipartParts(input, turnCapabilities, inlineRemaining)
        : undefined;
      return {
        captureLunaCheckpoint,
        ...(transcriptTransport ? { transcriptTransport: true as const } : {}),
        ...(explicitCompletionRequired && !input._compactionRequest ? { explicitCompletion: true as const } : {}),
        ...(experimentalMultipartParts !== undefined
          ? { experimentalMultipartParts }
          : {}),
        ...(inlineRemaining !== undefined
          ? { inlineConversationTokenRemaining: inlineRemaining }
          : {}),
      };
    };
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] Luna rolling checkpoint applied=${checkpointInput.applied}${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`,
      );
    }
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint");
        return;
      }
      capturedCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (capturedCheckpoint) lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      return answer;
    });
    const browserAbort = new AbortController();
    let browserOwnerSettled = false;
    const trackBrowserOwner = (browser: Promise<string>): Promise<string> => browser.finally(() => {
      browserOwnerSettled = true;
    });
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    const observedCapabilityTokens = new Set<string>();
    const observeCapabilityRetirement = (
      turnToken: string,
      externalProgress: ChatGptExternalTurnProgress,
    ): void => {
      if (observedCapabilityTokens.has(turnToken)) return;
      observedCapabilityTokens.add(turnToken);
      void broker.waitForRetirement(turnToken).then(
        () => {
          const retirement = new Error("Codex Native retired the turn binding before its tool work completed");
          externalProgress.retire(retirement);
          if (!browserOwnerSettled && !browserAbort.signal.aborted) browserAbort.abort(retirement);
        },
        error => {
          const failure = new Error("ChatGPT could not observe Codex Native turn retirement", {
            cause: error,
          });
          externalProgress.retire(failure);
          if (!browserAbort.signal.aborted) browserAbort.abort(failure);
        },
      );
    };
    const submission: NonNullable<ChatGptTurnRuntime["submission"]> = { phase: "prepared" };
    // A canonical compaction request is side-effect free and remains safe to rebuild after an
    // ambiguous browser send. Normal task prompts must never be replayed after Send activation.
    const submissionLifecycle = {
      ...(!parsed._compactionRequest ? {
        onSendActivated: () => { submission.phase = "send_activated" as const; },
      } : {}),
      onSubmitted: () => {
        if (!parsed._compactionRequest) submission.phase = "accepted";
        hooks.onCompactionProgress?.();
      },
    };
    const multipartProgressLifecycle = hooks.onCompactionProgress
      ? { onMultipartStageAcknowledged: hooks.onCompactionProgress }
      : {};
    if (manualRequest) {
      if (!environment) throw new Error("ChatGPT Zero Risk requires a trusted Codex environment");
      if (!retainedLauncherDescriptor) throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
      const token = deferred<string>();
      const externalProgress = new ChatGptExternalTurnProgress();
      const surfaceNonce = randomBytes(32).toString("base64url");
      const owner: LauncherManualTurnOwner = { traceId, helperPid: process.pid };
      let tokenSettled = false;
      let activeToken: string | undefined;
      let launcherStarted = false;
      let launcherEnded = false;
      const finishLauncher = async (status: LauncherManualTurnEnd["status"]): Promise<void> => {
        if (!launcherStarted || launcherEnded) return;
        await zeroRiskManualControl.end(retainedLauncherDescriptor, {
          ...owner,
          status,
          ...(status === "completed" && retainConversation ? { retain: true } : {}),
        });
        launcherEnded = true;
      };
      const runManual = async (): Promise<string> => {
        try {
          activeToken = await broker.registerSafe(environment, surfaceNonce, undefined, traceId);
          observeCapabilityRetirement(activeToken, externalProgress);
          const compiled = compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            activeToken,
            { manualControl: true },
          );
          const resumeCompiled = resumeInput
            ? compileChatGptWebPrompt(
              resumeInput,
              turnCapabilities,
              activeToken,
              { manualControl: true },
            )
            : undefined;
          for (const candidate of [compiled, resumeCompiled]) {
            if (!candidate) continue;
            if (candidate.multipart) {
              throw new ChatGptWebAdapterError("ChatGPT Zero Risk does not support multipart browser transport", {
                status: 409,
                errorType: "invalid_request_error",
                code: "manual_multipart_unsupported",
                retryable: false,
              });
            }
          }
          tokenSettled = true;
          token.resolve(activeToken);
          if (!parsed._compactionRequest) {
            trace.push({
              kind: "commentary",
              text: "> **Action required in Zero Risk**\n>\n> Open the launcher, copy and paste the prompt into ChatGPT, add any images yourself because Zero Risk cannot transfer them, select the `Codex Zero Risk` plugin and the model you want, send the prompt, then confirm it was sent in the launcher.",
            });
          }
          await zeroRiskManualControl.start(retainedLauncherDescriptor, {
            ...owner,
            prompt: compiled.text,
            ...(resumeCompiled ? { resumePrompt: resumeCompiled.text } : {}),
            ...(conversationKey ? { conversationKey } : {}),
            ...(parsed._compactionRequest ? { compaction: true as const } : {}),
          });
          launcherStarted = true;
          await zeroRiskManualControl.waitSent(retainedLauncherDescriptor, owner, {
            abortSignal: browserAbort.signal,
          });
          await broker.confirmSafeTurnSent(activeToken, surfaceNonce);
          submission.phase = "accepted";
          if (!parsed._compactionRequest) trace.push({
            kind: "commentary",
            text: "> **Waiting for ChatGPT**\n>\n> The prompt is marked `Sent`. Waiting for `Codex Zero Risk` to bind this turn through the selected ChatGPT connector.",
          });
          const terminalAbort = new AbortController();
          const abortTerminal = () => terminalAbort.abort();
          browserAbort.signal.addEventListener("abort", abortTerminal, { once: true });
          const terminalFailure = zeroRiskManualControl.waitTerminal(
            retainedLauncherDescriptor,
            owner,
            { abortSignal: terminalAbort.signal },
          ).then(observed => Promise.reject(safeManualTerminalError(observed.status)))
            .catch(error => terminalAbort.signal.aborted
              ? new Promise<never>(() => {})
              : Promise.reject(error));
          let answer: string;
          try {
            await Promise.race([
              broker.waitForSafeStart(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
            await zeroRiskManualControl.markStarted(retainedLauncherDescriptor, owner);
            if (!parsed._compactionRequest) trace.push({
              kind: "commentary",
              text: "> **Zero Risk connected**\n>\n> `Codex Zero Risk` is connected. ChatGPT is now working through the native Codex harness; progress remains visible in the launcher.",
            });
            answer = await Promise.race([
              broker.waitForSafeCompletion(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
          } finally {
            terminalAbort.abort();
            browserAbort.signal.removeEventListener("abort", abortTerminal);
          }
          text.push(answer);
          try {
            await finishLauncher("completed");
          } catch (controlError) {
            // The broker result is already authoritative. A launcher acknowledgement failure may
            // leave UI cleanup pending, but it must not replace a completed Codex answer with an
            // error or trigger a contradictory failed terminal mutation.
            console.error(
              `[chatgpt-web] completed Zero Risk turn but could not confirm launcher cleanup: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          return answer;
        } catch (error) {
          const normalized = safeManualAdapterError(error);
          // Capture the causal state before our own cleanup revokes the broker capability. The
          // retirement observer also aborts browserAbort, but that self-induced abort must not turn
          // an ordinary launcher/runtime failure into a user cancellation.
          const externallyAborted = browserAbort.signal.aborted;
          if (activeToken) await Promise.resolve(broker.revoke(activeToken, normalized)).catch(() => {});
          try {
            await finishLauncher(externallyAborted ? "aborted" : "failed");
          } catch (controlError) {
            console.error(
              `[chatgpt-web] failed to release Zero Risk launcher turn: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          throw normalized;
        }
      };
      const browserTurn = cancellableBrowserTurn(trackBrowserOwner(runManual()), browserAbort);
      void browserTurn.browser.catch(error => {
        if (tokenSettled) return;
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      });
      return {
        mode: "tools",
        token: token.promise,
        externalProgress,
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: checkpointInput.parsed,
        manualControl: { surfaceNonce },
        ...(conversationKey ? { conversationKey } : {}),
        ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
        retireCapability: async () => {
          if (activeToken) await broker.revoke(activeToken);
        },
        submission,
        cancel: (reason?: Error) => {
          browserTurn.cancel(reason);
          if (activeToken) {
            void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
              console.error(`[chatgpt-web] failed to revoke cancelled Zero Risk request: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        },
      };
    }
    if (!mode.localTools) {
      const browserTurn = cancellableBrowserTurn(finalizeCheckpoint(worker.run({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities: turnCapabilities,
        prepare: async () => ({
          ...compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            undefined,
            compileOptionsFor(checkpointInput.parsed),
          ),
          release: () => {},
        }),
        abortSignal: browserAbort.signal,
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        ...submissionLifecycle,
        ...multipartProgressLifecycle,
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
      })), browserAbort);
      return {
        mode: "read-only",
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: checkpointInput.parsed,
        submission,
        cancel: browserTurn.cancel,
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    const token = deferred<string>();
    const externalProgress = new ChatGptExternalTurnProgress();
    let tokenSettled = false;
    let activeToken: string | undefined;
    const prepareWith = async (input: CodexParsedRequest, latestUserRequest?: string | null) => {
      const turnToken = activeToken ?? await broker.register(
        environment,
        timeoutMs === undefined ? undefined : timeoutMs + 60_000,
        traceId,
      );
      activeToken = turnToken;
      try {
        const compiled = compileChatGptWebPrompt(
          input,
          turnCapabilities,
          turnToken,
          {
            ...compileOptionsFor(input),
            ...(latestUserRequest !== undefined ? { latestUserRequest } : {}),
          },
        );
        if (conversationKey !== undefined) {
          // Multipart stages carry the bulk inline, so the spend is every visible browser
          // message of this compile — not just the commit text the single-message shape has.
          inlineBudget.record(
            conversationKey,
            compiledChatGptWebMessages(compiled)
              .reduce((total, text) => total + estimateTokens(text, input.modelId), 0),
          );
          instructionLedger.record(
            conversationKey,
            chatGptTurnUserRevisionHistory(input).map(revision => chatGptTurnUserRevisionId(revision)),
          );
        }
        // Publish only after preparation succeeds: otherwise its failure revokes the token
        // before the response observer uses it and masks the cause as an expired capability.
        observeCapabilityRetirement(turnToken, externalProgress);
        if (!tokenSettled) {
          tokenSettled = true;
          token.resolve(turnToken);
        }
        return { ...compiled, release: () => {} };
      } catch (error) {
        await broker.revoke(turnToken);
        activeToken = undefined;
        throw error;
      }
    };
    const completionFence = {
      begin: async () => broker.beginCompletionFence(await token.promise),
      // A DOM answer is terminal in legacy mode. In explicit-completion mode it is only a stable
      // pause boundary: keep the MCP capability open for one retained corrective continuation.
      commit: async (revision: number) => explicitCompletionRequired
        ? broker.validateCompletionFence(await token.promise, revision)
        : broker.commitCompletionFence(await token.promise, revision),
    };
    const browserCallbacks = {
      onReasoningSummary: (value: string, continuation?: boolean) => trace.push({
        kind: "reasoning" as const,
        text: value,
        ...(continuation ? { continuation: true as const } : {}),
      }),
      onCommentary: (value: string, continuation?: boolean) => trace.push({
        kind: "commentary" as const,
        text: value,
        ...(continuation ? { continuation: true as const } : {}),
      }),
      // With explicit completion, browser text is progress commentary; codex_turn_complete owns
      // the only terminal answer. Compatibility/test providers retain the legacy DOM final.
      onTextDelta: (delta: string) => {
        if (!explicitCompletionRequired) text.push(delta);
      },
    };
    let terminalAccepted = false;
    // R1 anchor shared by the resume nudge and every completion-recovery round: the genuine
    // latest human instruction from the canonical history this turn replays.
    const latestUserRequest = chatGptLatestUserRequestText(checkpointInput.parsed.context.messages);
    const runBrowserSequence = async (): Promise<string> => {
      // An edited resubmit reuses the conversation key with history the retained conversation
      // never saw. Release the stale conversation before leasing so this turn seeds a fresh one.
      if (editedResubmit && conversationKey !== undefined) {
        instructionLedger.forget(conversationKey);
        inlineBudget.forget(conversationKey);
        if (retainedLauncherDescriptor) {
          await releaseLauncherRetainedConversation(retainedLauncherDescriptor, conversationKey);
        }
      }
      let initialAnswer: string;
      try {
        initialAnswer = await finalizeCheckpoint(worker.run({
          traceId,
          modelId: parsed.modelId,
          reasoning: parsed.options.reasoning,
          capabilities: turnCapabilities,
          prepare: () => prepareWith(checkpointInput.parsed),
          ...(resumeInput ? { prepareResume: () => prepareWith(resumeInput) } : {}),
          // The nudge replaces the message list, so its R1 block must come from the full
          // canonical history; suppress it entirely when no genuine instruction exists.
          ...(resumeNudgeInput ? { prepareResume: () => prepareWith(resumeNudgeInput, latestUserRequest ?? null) } : {}),
          ...(retainConversation ? { retainConversation: true, conversationKey } : {}),
          abortSignal: browserAbort.signal,
          ...(parsed._compactionRequest ? { compaction: true } : {}),
          ...submissionLifecycle,
          ...multipartProgressLifecycle,
          ...browserCallbacks,
          externalProgress,
          completionFence,
          ...(captureLunaCheckpoint ? {
            captureLunaCheckpoint: true,
            onLunaCheckpoint: captureCheckpoint,
          } : {}),
        }));
      } catch (error) {
        await healOverspentConversation(error, conversationKey);
        throw error;
      }
      if (!explicitCompletionRequired || !conversationKey || browserAbort.signal.aborted) {
        return initialAnswer;
      }
      const turnToken = await token.promise;
      let previousRoundText = initialAnswer;
      const yieldAtTokens = chatGptWebContextYieldTokenLimit(
        currentUsageInput(parsed), turnCapabilities, experimentalBiggerContext,
      );
      // Codex compacts from the history it will replay, and the bridge's own request estimate is
      // the same number it reports as usage — so this is the budget signal available before the
      // turn closes. The first browser answer joins that history too.
      let projectedTokens = yieldAtTokens === undefined ? 0
        : estimateChatGptWebUsage(currentUsageInput(parsed), {}, turnCapabilities, experimentalBiggerContext).inputTokens
          + estimateTokens(initialAnswer, parsed.modelId);
      // The model owns the finish line only through codex_turn_complete; the bridge owns the
      // continuation. Rounds run until that terminal call, an idle repeat, the context budget,
      // an abort, or the recovery cap — an unbounded loop let a lost instruction spin forever.
      for (let round = 1; !browserAbort.signal.aborted && !terminalAccepted && round <= CHATGPT_WEB_MAX_COMPLETION_RECOVERY_ROUNDS; round += 1) {
        const budgetExhausted = yieldAtTokens !== undefined && projectedTokens >= yieldAtTokens;
        const continuationText = explicitCompletionRecoveryPrompt(turnToken, previousRoundText, budgetExhausted, latestUserRequest);
        const continuationPrepared = async () => ({
          text: continuationText,
          images: [],
          release: () => {},
        });
        // Continuation rounds bypass prepareWith, so their inline spend joins the same
        // per-conversation ledger the seeded and resumed messages use.
        if (conversationKey !== undefined) {
          inlineBudget.record(conversationKey, estimateTokens(continuationText, parsed.modelId));
        }
        console.warn(`[chatgpt-web] browser turn ${traceId} ended without codex_turn_complete; requesting retained continuation ${round}`);
        let answer: string;
        try {
          answer = await worker.run({
            traceId: round === 1 ? `${traceId}_completion_recovery` : `${traceId}_completion_recovery_${round}`,
            modelId: parsed.modelId,
            reasoning: parsed.options.reasoning,
            capabilities: turnCapabilities,
            prepare: continuationPrepared,
            prepareResume: continuationPrepared,
            retainConversation: true,
            requireRetainedConversation: true,
            conversationKey,
            abortSignal: browserAbort.signal,
            ...browserCallbacks,
            externalProgress,
            completionFence,
          });
        } catch (error) {
          await healOverspentConversation(error, conversationKey);
          throw error;
        }
        // A terminal call can resolve a moment after the round's DOM settles; give the
        // completion race a short window to claim the turn before continuing the loop.
        for (let wait = 0; wait < 12 && !terminalAccepted && !browserAbort.signal.aborted; wait += 1) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (browserAbort.signal.aborted || terminalAccepted) return answer;
        if (isRepeatedStatus(previousRoundText, answer)) {
          console.warn(`[chatgpt-web] browser turn ${traceId} continuation ${round} repeated the previous status; handing the settled text to auto-completion`);
          return answer;
        }
        projectedTokens += estimateTokens(answer, parsed.modelId);
        if (budgetExhausted) {
          console.warn(`[chatgpt-web] browser turn ${traceId} continuation ${round} used the context budget (${
            projectedTokens} >= ${yieldAtTokens}); yielding the turn so Codex can compact at its boundary`);
          return answer;
        }
        trace.push({ kind: "commentary" as const, text: answer });
        previousRoundText = answer;
      }
      if (!terminalAccepted && !browserAbort.signal.aborted) {
        // The recovery cap replaces the old unbounded continuation loop: close with the last
        // settled text (auto-completion still guards it) instead of nudging forever.
        console.warn(`[chatgpt-web] browser turn ${traceId} reached the completion recovery limit (${CHATGPT_WEB_MAX_COMPLETION_RECOVERY_ROUNDS} rounds) without codex_turn_complete; closing with the last settled text`);
      }
      return previousRoundText;
    };
    const browserTurn = cancellableBrowserTurn(trackBrowserOwner(runBrowserSequence()), browserAbort);
    void browserTurn.browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const explicitCompletion = explicitCompletionRequired
      ? token.promise.then(turnToken => Promise.race([
        broker.waitForCompletion(turnToken),
        browserTurn.browser.then(async finalText => {
          // ChatGPT sometimes finishes with complete DOM text yet never calls codex_turn_complete.
          // Accept that text as the answer only when the broker's own guards (pending invocations,
          // empty text, retired token) pass; otherwise keep the explicit-completion contract strict.
          try {
            await broker.completeTurn(turnToken, finalText);
          } catch (reason) {
            console.warn(`[chatgpt-web] browser turn ${traceId} auto-completion refused: ${reason instanceof Error ? reason.message : String(reason)}`);
            throw new ChatGptWebAdapterError(
              "ChatGPT ended the response without confirming that the requested Codex work was complete. Retry the task; progress text was not accepted as a final answer.",
              {
                status: 502,
                errorType: "server_error",
                code: "chatgpt_completion_not_confirmed",
                retryable: false,
              },
            );
          }
          console.warn(`[chatgpt-web] browser turn ${traceId} auto-completed from final DOM text after codex_turn_complete was never called`);
          return finalText;
        }),
      ])).then(answer => {
        terminalAccepted = true;
        text.push(answer);
        // Completion is authoritative; the browser no longer needs to render another assistant
        // message after the connector returns its acknowledgement.
        browserTurn.cancel();
        return answer;
      })
      : undefined;
    const terminalBrowser = explicitCompletion ?? browserTurn.browser;
    return {
      mode: "tools",
      token: token.promise,
      externalProgress,
      browser: terminalBrowser,
      physicalSettlement: browserTurn.physicalSettlement,
      trace,
      text,
      usageInput: checkpointInput.parsed,
      ...(conversationKey ? { conversationKey } : {}),
      ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
      retireCapability: async () => {
        if (activeToken) await broker.revoke(activeToken);
      },
      submission,
      cancel: (reason?: Error) => {
        browserTurn.cancel(reason);
        if (activeToken) {
          void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
            console.error(`[chatgpt-web] failed to revoke cancelled turn token: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
    };
  };

  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      const runChatGptWebTurn = async (): Promise<void> => {
        const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
        if (manualRequest !== manualInteraction) {
          emit({
            type: "error",
            message: manualInteraction
              ? "ChatGPT Zero Risk requires the Zero Risk Web model route."
              : "The Zero Risk Web model route is unavailable while automatic browser interaction is enabled.",
            status: 409,
            errorType: "invalid_request_error",
            code: "browser_interaction_mode_mismatch",
            retryable: false,
          });
          return;
        }
        const turnCapabilities = parsed._compactionRequest && !manualRequest
          ? { ...configuredCapabilities, localToolsEnabled: false }
          : configuredCapabilities;
        const mode = manualRequest
          ? { localTools: true }
          : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
        const structuredOutputValidator = parsed._compactionRequest
          ? undefined
          : createChatGptStructuredOutputValidator(parsed.options.outputFormat);
        const bufferStructuredOutput = structuredOutputValidator !== undefined;
        const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
        const exhaustedRetry = chatGptWebTurnRetryPolicy.exhaustedError(retryKey);
        if (exhaustedRetry) {
          emit({
            type: "error",
            message: exhaustedRetry.message,
            status: exhaustedRetry.status,
            errorType: exhaustedRetry.errorType,
            code: exhaustedRetry.code,
            retryable: false,
          });
          return;
        }
        let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
        if (mode.localTools) {
          try {
            environment = environmentStore.resolve(parsed);
          } catch (error) {
            const identity = extractChatGptTurnIdentity(parsed);
            console.warn(
              `[chatgpt-web] trusted environment unavailable (thread_id=${identity.threadId ? "present" : "missing"}, turn_id=${identity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ?? "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length})`,
            );
            throw error;
          }
        }
        if (parsed._compactionRequest) {
          const structuredCompactionRequired = parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
            && configuredCapabilities.localToolsEnabled;
          if (structuredCompactionRequired
            && (!retainedLauncherDescriptor || (!manualRequest && !structuredBroker))) {
            emit({
              type: "error",
              message: manualRequest
                ? "Zero Risk could not resume the active ChatGPT conversation for context handoff. Retry the task from the Launcher."
                : "ChatGPT could not resume the active conversation for context handoff. Retry the task.",
              status: 409,
              errorType: "invalid_request_error",
              code: "compaction_control_unavailable",
              retryable: false,
            });
            return;
          }
          if (structuredCompactionRequired) {
            const compactionExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
            const compactedSourceExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
            const handoffTraceId = createHash("sha256")
              .update(`${compactionExecutionKey}:handoff`)
              .digest("hex")
              .slice(0, 12);
            const compactionTraceId = createHash("sha256")
              .update(compactionExecutionKey)
              .digest("hex")
              .slice(0, 12);
            const compactionNativeIdentity = extractChatGptTurnIdentity(parsed);
            let sharedSummary = existingStructuredCompactionRun(compactionExecutionKey);
            if (!sharedSummary) {
              sharedSummary = runStructuredCompactionOnce(
                compactionExecutionKey,
                {
                  ownerKey: `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`,
                  traceIds: [
                    compactionTraceId,
                    handoffTraceId,
                    `${handoffTraceId}_fallback`,
                  ],
                  ...(compactionNativeIdentity.threadId
                    ? { nativeThreadId: compactionNativeIdentity.threadId }
                    : {}),
                  ...(compactionNativeIdentity.turnId
                    ? { nativeTurnId: compactionNativeIdentity.turnId }
                    : {}),
                },
                async (operatorSignal, retainOwnershipUntil) => {
                  const handoffTimeoutMs = Math.min(
                    timeoutMs ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                    MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                  );
                  const handoffDeadline = new AbortController();
                  const handoffTimeoutError = new ChatGptWebAdapterError(
                    `ChatGPT compaction did not fully settle within ${handoffTimeoutMs}ms`,
                    {
                      status: 409,
                      errorType: "invalid_request_error",
                      code: "compaction_handoff_timeout",
                      retryable: false,
                    },
                  );
                  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
                  const armHandoffDeadline = (): void => {
                    if (handoffDeadline.signal.aborted) return;
                    if (handoffTimer) clearTimeout(handoffTimer);
                    handoffTimer = setTimeout(
                      () => handoffDeadline.abort(handoffTimeoutError),
                      handoffTimeoutMs,
                    );
                    handoffTimer.unref?.();
                  };
                  armHandoffDeadline();
                  const operationSignal = AbortSignal.any([operatorSignal, handoffDeadline.signal]);
                  const sourceConversationKey = chatGptConversationKey(parsed, executionNamespace);
                  const runFreshCompactionFallback = async (reason: string): Promise<string> => {
                    console.warn(`[chatgpt-web] retained compaction fallback=${reason}`);
                    // The fallback is a new bounded phase. Each exact multipart acknowledgement
                    // and the final accepted compact prompt re-arms the five-minute liveness budget;
                    // transport time cannot consume the model-generation window.
                    armHandoffDeadline();
                    const fallbackRuntime = startRuntime(
                      parsed,
                      manualRequest ? environment : undefined,
                      `${handoffTraceId}_fallback`,
                      turnCapabilities,
                      { onCompactionProgress: armHandoffDeadline },
                    );
                    retainOwnershipUntil(fallbackRuntime.physicalSettlement);
                    try {
                      const rawSummary = await withAbort(fallbackRuntime.browser, operationSignal);
                      await withAbort(fallbackRuntime.physicalSettlement, operationSignal);
                      return canonicalizeCompactionHandoff(parsed, rawSummary);
                    } catch (error) {
                      fallbackRuntime.cancel(error instanceof Error ? error : new Error(String(error)));
                      // The shared owner retains physical settlement independently of this error.
                      // Neither a timeout nor operator cancellation can open a competing trace.
                      throw error;
                    }
                  };
                  let source: ChatGptTurnSession | undefined;
                  let preserveFinalResponse = false;
                  try {
                    // The previous compaction may already have detached the retained head while
                    // its browser/helper is still unwinding. Do not inspect that old epoch or
                    // decide to open a fresh fallback until physical release has completed.
                    if (sourceConversationKey) {
                      await chatGptTurnSessions.waitForConversationRetirement(
                        sourceConversationKey,
                        operationSignal,
                      );
                    }
                    source = sourceConversationKey
                      ? chatGptTurnSessions.findConversationHead(sourceConversationKey)
                      : undefined;
                    preserveFinalResponse = !source?.isActive()
                      && source?.settledOutcome()?.type === "final";
                    const retainedKey = source?.conversationKey();
                    if (!source || !retainedKey) {
                      return await runFreshCompactionFallback("source_unavailable_before_handoff");
                    }
                    let rawSummary: string;
                    if (manualRequest && source.isActive() && source.runtime.mode === "tools") {
                      const zeroRiskSummary = await settleActiveZeroRiskCompactionSource(
                        parsed,
                        source,
                        broker,
                        operationSignal,
                      );
                      if (zeroRiskSummary === undefined) {
                        preserveFinalResponse = true;
                        rawSummary = await runFreshCompactionFallback("zero_risk_source_had_no_compaction_boundary");
                      } else {
                        rawSummary = zeroRiskSummary;
                      }
                    } else if (manualRequest) {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      rawSummary = await runFreshCompactionFallback("zero_risk_source_already_completed");
                    } else if (source.isActive() && source.runtime.mode === "tools") {
                      const settlement = await settleActiveCompactionSource(
                        parsed,
                        source,
                        structuredBroker!,
                        operationSignal,
                      );
                      preserveFinalResponse = !settlement.compactionInstructionDelivered;
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                      );
                    } else {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                      );
                    }
                    const summary = canonicalizeCompactionHandoff(parsed, rawSummary);
                    await withAbort(
                      preserveFinalResponse
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey),
                      operationSignal,
                    );
                    return summary;
                  } catch (error) {
                    const retainedKey = source?.conversationKey();
                    if (!retainedKey) throw error;
                    let handoffError = error instanceof Error ? error : new Error(String(error));
                    try {
                      // Operator cancellation ends the logical compaction, but cancel-all must not
                      // acknowledge until the retained browser/helper owner has physically retired.
                      await (preserveFinalResponse
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source!,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey));
                    } catch (retirementError) {
                      handoffError = new AggregateError(
                        [handoffError, retirementError instanceof Error ? retirementError : new Error(String(retirementError))],
                        "Structured compaction failed and its retained conversation could not be retired",
                      );
                    }
                    if (handoffError instanceof ChatGptWebAdapterError
                      && handoffError.code === "compaction_source_unavailable") {
                      return await runFreshCompactionFallback("source_disappeared_before_handoff");
                    }
                    throw handoffError;
                  } finally {
                    if (handoffTimer) clearTimeout(handoffTimer);
                  }
                },
              );
            }
            emit({ type: "heartbeat" });
            let summary: string;
            try {
              summary = await withAbort(sharedSummary, incoming.abortSignal);
            } catch (error) {
              if (incoming.abortSignal?.aborted
                && error instanceof DOMException
                && error.name === "AbortError") {
                // The observer detached; the shared exact compaction round continues and remains
                // available to a canonical reconnect without a second browser submission.
                throw error;
              }
              const handoffError = error instanceof Error ? error : new Error(String(error));
              console.error("[chatgpt-web] structured context handoff failed:", handoffError);
              emit({
                type: "error",
                message: "ChatGPT did not complete the context handoff. Retry the task.",
                status: 409,
                errorType: "invalid_request_error",
                code: "compaction_handoff_failed",
                retryable: false,
              });
              return;
            }
            emit({ type: "text_delta", text: summary, phase: "final_answer" });
            emitBrowserCompletion(
              { type: "final", answer: summary },
              estimateChatGptWebUsage(parsed, { answer: summary, reasoning: [] }, turnCapabilities, experimentalBiggerContext),
              emit,
            );
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }
          const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
          await chatGptTurnSessions.retireAndWait(responseExecutionKey, incoming.abortSignal);
        }
        const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
        const ownerKey = `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`;
        const nativeIdentity = extractChatGptTurnIdentity(parsed);
        const nativeTurnId = nativeIdentity.turnId;
        if (!nativeTurnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser ownership");
        const abortedTurnIds = manualRequest ? new Set(priorChatGptAbortedTurnIds(parsed)) : undefined;
        if (abortedTurnIds?.size) {
          chatGptTurnSessions.retireAbortedOwnerTurns(ownerKey, abortedTurnIds, executionKey);
        }
        const traceId = chatGptWebTraceId(provider, parsed);
        const session = await chatGptTurnSessions.getOrCreateAfterOwnerRetirement(
          executionKey,
          ownerKey,
          () => startRuntime(parsed, environment, traceId, turnCapabilities),
          traceId,
          incoming.abortSignal,
          nativeTurnId,
          nativeIdentity.threadId,
          chatGptInstructionLineage(parsed),
        );
        const roundKey = chatGptTurnRoundKey(parsed);
        const emitRoundEvents = (events: readonly AdapterEvent[]): void => {
          // Journal the complete synchronous event batch before touching the HTTP observer. If the
          // observer disconnects midway through emission, an exact reconnect can replay the entire
          // canonical batch instead of losing the already-drained tail.
          session.appendRoundEvents(roundKey, events);
          for (const event of events) emit(event);
        };
        const emitRoundBatch = (
          produce: (buffer: (event: AdapterEvent) => void) => void,
        ): void => {
          const events: AdapterEvent[] = [];
          produce(event => events.push(event));
          emitRoundEvents(events);
        };
        const emitRoundEvent = (event: AdapterEvent): void => emitRoundEvents([event]);
        try {
          await session.runExclusive(async () => {
            const replay = session.roundEvents(roundKey);
            replayEvents(replay, emit);
            if (session.roundCompleted(roundKey)) {
              const failure = session.roundFailure(roundKey);
              if (failure) throw failure;
              return;
            }
            if (session.roundHasTerminalEvent(roundKey)) {
              session.completeRound(roundKey);
              return;
            }
            const settled = session.settledOutcome();
            if (settled) {
              if (settled.type === "error") throw settled.error;
              const trace = session.runtime.trace.drain();
              const completedTextDeltas = session.runtime.text.drain();
              const finalReplay = replay.length === 0
                && trace.length === 0
                && completedTextDeltas.length === 0
                ? session.eventsForFinalReplay()
                : [];
              if (finalReplay.length > 0) {
                session.appendRoundReasoning(roundKey, session.reasoningForFinalReplay());
                emitRoundEvents(finalReplay);
              } else {
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                if (replay.length === 0 && !parsed._compactionRequest) {
                  emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
                }
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
                if (!bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas(completedTextDeltas, buffer));
                }
              }
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              structuredOutputValidator?.(settled.answer);
              if (bufferStructuredOutput) {
                emitRoundBatch(buffer => emitTextDeltas([settled.answer], buffer));
              }
              const reasoning = session.roundReasoning(roundKey);
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(session.roundEvents(roundKey));
              emitRoundBatch(buffer => emitBrowserCompletion(
                settled,
                estimateChatGptWebUsage(currentUsageInput(parsed), { answer: settled.answer, reasoning }, turnCapabilities, experimentalBiggerContext),
                buffer,
              ));
              session.completeRound(roundKey);
              chatGptWebTurnRetryPolicy.clear(retryKey);
              return;
            }

            let turnToken: string | undefined;
            if (session.runtime.mode === "tools") {
              turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
              if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
              await broker.updateEnvironment(turnToken, environment);

              const outstanding = session.outstanding();
              if (outstanding.length > 0) {
                const results = currentToolResults(parsed, session);
                if (results.length === 0) {
                  const reasoning = session.reasoningForOutstandingReplay();
                  if (replay.length === 0) emitRoundEvents(session.eventsForOutstandingReplay());
                  emitRoundBatch(buffer => emitToolBatch(
                    outstanding,
                    estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning, toolRequests: outstanding }, turnCapabilities, experimentalBiggerContext),
                    buffer,
                  ));
                  session.completeRound(roundKey);
                  return;
                }
                if (results.length !== outstanding.length) {
                  throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
                }
                // A launcher-retained turn keeps driving the same browser conversation across every
                // Codex request, so this is the last point where the model can still be redirected
                // from another tool round to a handoff the next turn can resume from.
                const delivered = results.map(message => ({ message, result: brokerResult(message) }));
                const budgetExhausted = session.runtime.conversationKey !== undefined
                  && contextBudgetExhausted(
                    currentUsageInput(parsed), turnCapabilities, experimentalBiggerContext,
                    delivered.reduce((total, { message }) =>
                      total + estimateTokens(toolResultText(message), parsed.modelId), 0),
                  );
                if (budgetExhausted) {
                  delivered.at(-1)!.result.content.push({ type: "text", text: CHATGPT_WEB_CONTEXT_BUDGET_INSTRUCTION });
                }
                for (const { message, result } of delivered) {
                  await broker.completeTool(turnToken, message.toolCallId, result);
                  session.runtime.externalProgress.recordToolResult();
                  session.markResultDelivered(message.toolCallId);
                }
              }
            } else if (session.outstanding().length > 0) {
              throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
            }

            const toolWaitAbort = new AbortController();
            try {
              const roundReasoning = session.roundReasoning(roundKey);
              const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
                roundReasoning.push(...trace.map(event => event.text));
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
              };
              const emitNewText = (deltas: string[]) => {
                if (!bufferStructuredOutput) emitRoundBatch(buffer => emitTextDeltas(deltas, buffer));
              };
              if (replay.length === 0 && !parsed._compactionRequest) {
                emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              const externalProgress = session.runtime.mode === "tools"
                ? session.runtime.externalProgress
                : undefined;
              const armNextTools = () => turnToken
                ? broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(async requests => {
                  if (!externalProgress) {
                    throw new Error("ChatGPT broker returned tools for a read-only browser turn");
                  }
                  if (requests.length > 0) {
                    const revision = externalProgress.recordToolBatch(requests.length);
                    if (!session.runtime.manualControl) {
                      // The browser outcome is in the same race below and owns the semantic DOM and
                      // renderer deadlines. A second fixed timer here can retire an accepted turn
                      // while its same-tab observer is still recovering. Keep the causal barrier —
                      // tools are not emitted until the browser captures their text boundary — but
                      // let browser settlement or request cancellation end the wait.
                      await externalProgress.waitForToolBatchObservation(
                        revision,
                        toolWaitAbort.signal,
                      );
                    }
                    externalProgress.assertToolBatchActive(revision);
                  }
                  return { type: "tools" as const, requests };
                }).catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error))
                : undefined;
              let nextTools = armNextTools();
              const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
              const finishBrowserOutcome = async (completedOutcome: ChatGptBrowserOutcome): Promise<void> => {
                // Zero Risk completion and its owner-only empty-batch signal are resolved by the
                // same broker transition. Drain once more so the accepted final answer cannot be
                // overtaken by the terminal owner notification.
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(session.roundEvents(roundKey));
                if (turnToken) await broker.revoke(turnToken);
                if (completedOutcome.type === "error") throw completedOutcome.error;
                if (session.runtime.text.value() !== completedOutcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                structuredOutputValidator?.(completedOutcome.answer);
                if (bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas([completedOutcome.answer], buffer));
                }
                emitRoundBatch(buffer => emitBrowserCompletion(
                  completedOutcome,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { answer: completedOutcome.answer, reasoning: roundReasoning }, turnCapabilities, experimentalBiggerContext),
                  buffer,
                ));
                session.completeRound(roundKey);
                chatGptWebTurnRetryPolicy.clear(retryKey);
              };
              const waitForTrace = () => session.runtime.trace.wait(toolWaitAbort.signal)
                .then(() => ({ type: "trace" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              const waitForText = () => session.runtime.text.wait(toolWaitAbort.signal)
                .then(() => ({ type: "text" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              let nextTrace = waitForTrace();
              let nextText = waitForText();
              for (;;) {
                const next = await withAbort(
                  Promise.race([
                    ...(nextTools ? [nextTools] : []),
                    browserOutcome,
                    nextTrace,
                    nextText,
                  ]),
                  incoming.abortSignal,
                );
                if (next.type === "trace") {
                  emitNewTrace(session.runtime.trace.drain());
                  nextTrace = waitForTrace();
                  continue;
                }
                if (next.type === "text") {
                  emitNewText(session.runtime.text.drain());
                  nextText = waitForText();
                  continue;
                }
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                if (next.type === "browser") {
                  await finishBrowserOutcome(next.outcome);
                  return;
                }
                if (!turnToken || session.runtime.mode !== "tools" || !externalProgress) {
                  throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
                }
                if (next.requests.length === 0) {
                  if (!session.runtime.manualControl) {
                    throw new Error("ChatGPT tool bridge returned an empty batch");
                  }
                  await finishBrowserOutcome(await session.browserOutcome);
                  return;
                }
                validateBatchTools(parsed, next.requests);
                session.setOutstanding(next.requests, roundReasoning, session.roundEvents(roundKey));
                emitRoundBatch(buffer => emitToolBatch(
                  next.requests,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities, experimentalBiggerContext),
                  buffer,
                ));
                session.completeRound(roundKey);
                return;
              }
            } finally {
              toolWaitAbort.abort();
            }
          });
        } catch (error) {
          if (incoming.abortSignal?.aborted && error instanceof DOMException && error.name === "AbortError") {
            if (session.runtime.manualControl) {
              // Zero Risk is user-driven and has no DOM observer that can distinguish continued
              // work from a stopped native turn. A closed Responses stream is therefore terminal:
              // revoke the MCP capability and release the Launcher tab instead of leaving a task
              // that Codex already shows as stopped waiting forever.
              chatGptTurnSessions.retire(executionKey, session);
            }
            // Automatic browser turns keep their exact execution and journal for reconnect. Their
            // owned DOM observer can continue proving the same accepted ChatGPT submission.
            throw error;
          }
          const turnError = submittedTurnFailure(session, error);
          const handledError = turnError instanceof ChatGptWebAdapterError && turnError.retryable
            ? chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, turnError)
            : turnError;
          if (!(turnError instanceof ChatGptWebAdapterError && turnError.retryable)) {
            chatGptWebTurnRetryPolicy.clear(retryKey);
          }
          if (handledError instanceof ChatGptWebAdapterError && !handledError.retryable) {
            // A deterministic request failure remains replayable so a native reconnect cannot burn
            // another browser attempt. Every other failure retires the browser session: client
            // disconnects, stage failures, and retryable ChatGPT errors must start a fresh surface
            // instead of replaying one rejected browser outcome for the registry's full TTL.
            session.cancel();
          } else {
            chatGptTurnSessions.retire(executionKey, session);
          }
          if (session.runtime.mode === "tools") {
            void session.runtime.token.then(turnToken => broker.revoke(turnToken)).catch(() => {});
          }
          if (handledError instanceof ChatGptWebAdapterError) {
            emitRoundEvent({
              type: "error",
              message: handledError.message,
              status: handledError.status,
              errorType: handledError.errorType,
              code: handledError.code,
              retryable: handledError.retryable,
            });
            session.completeRound(roundKey);
            return;
          }
          session.failRound(roundKey, turnError);
          chatGptWebTurnRetryPolicy.clear(retryKey);
          throw turnError;
        }
      };

      // Arm this before any awaited work, including environment lookup and owner retirement.
      const heartbeat = setInterval(
        () => emit({ type: "heartbeat" }),
        CHATGPT_WEB_ADAPTER_HEARTBEAT_MS,
      );
      try {
        emit({ type: "heartbeat" });
        await runChatGptWebTurn();
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
