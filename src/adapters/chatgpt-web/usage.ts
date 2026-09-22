import { estimateTokens } from "../../lib/token-estimate";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  isChatGptWebZeroRiskBackendModel,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import type { CodexParsedRequest, CodexUsage } from "../../types";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import {
  CHATGPT_BIGGER_CONTEXT_PARTS,
  compileChatGptWebPrompt,
  type ChatGptWebMultipartPartCount,
  type CompiledChatGptWebPrompt,
  type CompileChatGptWebPromptOptions,
} from "./prompt";
import { extractChatGptTurnIdentity } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import type { BrokerToolRequest } from "./turn-broker";

// The real capability has the same length. Keeping it out of usage accounting would make
// estimates differ slightly between the prepared browser prompt and later Codex tool rounds.
const ESTIMATE_TURN_TOKEN = "turn_00000000000000000000000000000000";

export interface ChatGptWebRoundEvidence {
  answer?: string;
  reasoning?: string[];
  toolRequests?: BrokerToolRequest[];
}

function conservativeTextTokens(text: string, modelId: string): number {
  return estimateTokens(text, modelId);
}

export function estimateChatGptWebInputTokens(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options: CompileChatGptWebPromptOptions = {},
): number {
  const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
  const mode = manual
    ? { localTools: true }
    : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const identity = extractChatGptTurnIdentity(parsed);
  const compiled = compileChatGptWebPrompt(
    parsed,
    capabilities,
    mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    {
      ...options,
      ...(manual ? { manualControl: true as const } : {}),
      captureLunaCheckpoint: parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
        && !parsed._compactionRequest
        && Boolean(identity.threadId && identity.turnId),
    },
  );
  return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
}

/**
 * The compaction threshold chooses the initial part count. Whole records and composer limits
 * can require more parts even when the total token estimate is small. Plan before submission;
 * compaction always receives all three parts without passing through the legacy inline budget.
 */
export function resolveBiggerContextMultipartParts(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  inlineConversationTokenRemaining?: number,
): ChatGptWebMultipartPartCount | undefined {
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
    throw new Error("Bigger Context is unavailable for ChatGPT Zero Risk");
  }
  if (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error("Bigger Context is unavailable for Luna because its accumulated browser transcript still shares one 28,000-token transport budget");
  }
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  if (parsed._compactionRequest) {
    // A compaction checkpoint summarizes the whole canonical history. Staging it across three
    // inline parts cannot fit histories that outgrew the measured per-conversation boundary, and
    // the whole-context attachment transport carries any size — so compaction never stages.
    return undefined;
  }
  const { contextWindow, autoCompactTokenLimit } = resolveChatGptWebContextLimits(
    CHATGPT_WEB_BACKEND_MODEL,
    mode.effort,
    { ...capabilities, experimentalBiggerContext: false },
  );
  const compile = (parts?: ChatGptWebMultipartPartCount): CompiledChatGptWebPrompt => compileChatGptWebPrompt(
    parsed, capabilities, mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    {
      experimentalMultipartParts: parts,
      // Bigger Context selection must measure the raw inline envelope. Otherwise the ordinary
      // attachment fallback makes an oversized prompt appear to fit and prevents multipart from
      // being selected even though the user explicitly enabled it.
      disableGeneratedTextAttachments: true,
    },
  );
  const inline = compile();
  const inputTokens = estimateCompiledChatGptWebInputTokens(inline, parsed.modelId);
  const initialParts = biggerContextPartCount(inputTokens, autoCompactTokenLimit, false);

  const fits = (compiled: CompiledChatGptWebPrompt): boolean => {
    const messages = compiledChatGptWebMessages(compiled);
    // Inert stages may use any explicitly available staging effort; execution keeps the chosen
    // effort. These are the widest stage modes used by the browser's existing selector.
    const stagingEffort = capabilities.proAvailable ? "max" : "medium";
    for (const [index, text] of messages.entries()) {
      const final = index === messages.length - 1;
      const effort = final ? mode.effort : stagingEffort;
      const { browserComposerCharLimit } = resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities);
      if (browserComposerCharLimit !== undefined && text.length > browserComposerCharLimit) return false;
      const budget = resolveChatGptWebMessageTokenBudget(
        CHATGPT_WEB_BACKEND_MODEL, effort, capabilities, final ? estimateChatGptWebImageTokens(compiled) : 0,
      );
      if (estimateTokens(text, parsed.modelId) > budget) return false;
    }
    // The measured inline boundary is cumulative per conversation: a retained chat that already
    // spent its budget rejects even well-formed stages. Staging must then return undefined so the
    // whole-context attachment transport — which does not ride this boundary — carries the task.
    if (inlineConversationTokenRemaining !== undefined
      && messages.reduce((total, text) => total + estimateTokens(text, parsed.modelId), 0)
        > inlineConversationTokenRemaining) return false;
    return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId) < contextWindow * messages.length;
  };
  if (initialParts === undefined && fits(inline)) return undefined;
  for (const parts of [2, CHATGPT_BIGGER_CONTEXT_PARTS] as const) {
    if (parts < (initialParts ?? 2)) continue;
    try {
      if (fits(compile(parts))) return parts;
    } catch {
      // A staging plan whose records cannot fit its part budgets is not a plan. The ordinary
      // whole-context attachment transport carries what staging cannot, so fall through instead
      // of failing the request.
    }
  }
  // Every extra part is another full browser message, so the measured per-message boundary caps the
  // whole inline envelope (three Plus stages hold 135,000 tokens). Report a single-message plan
  // then: the prompt moves the bulk into its whole-context attachment, which carried 82,337
  // estimated tokens in one accepted turn while a 48,141-token inline message was rejected.
  return undefined;
}

export function biggerContextPartCount(
  inputTokens: number,
  onePartLimit: number,
  compaction: boolean,
): ChatGptWebMultipartPartCount | undefined {
  if (compaction) return CHATGPT_BIGGER_CONTEXT_PARTS;
  if (inputTokens < onePartLimit) return undefined;
  if (inputTokens < onePartLimit * 2) return 2;
  return CHATGPT_BIGGER_CONTEXT_PARTS;
}

/** A yielded turn still needs room for its own handoff summary, so the reserve scales with the window. */
const CONTEXT_YIELD_RESERVE_RATIO = 0.1;
const CONTEXT_YIELD_MAX_RESERVE_TOKENS = 24_000;

/**
 * Token line at which the bridge must hand the turn back to Codex. Codex only evaluates automatic
 * compaction between turns, so growth that crosses the limit inside one turn is a hard overflow
 * instead of a compaction. Returns undefined for routes whose history never reaches that line
 * through Codex (Luna checkpoints) or that have no bridge-driven continuation (Zero Risk).
 */
export function chatGptWebContextYieldTokenLimit(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  experimentalBiggerContext = false,
): number | undefined {
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId) || parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    return undefined;
  }
  const { effort } = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const { autoCompactTokenLimit } = resolveChatGptWebContextLimits(
    CHATGPT_WEB_BACKEND_MODEL,
    effort,
    { ...capabilities, experimentalBiggerContext },
  );
  const reserve = Math.min(
    CONTEXT_YIELD_MAX_RESERVE_TOKENS,
    Math.round(autoCompactTokenLimit * CONTEXT_YIELD_RESERVE_RATIO),
  );
  return autoCompactTokenLimit - reserve;
}

function roundEvidenceText(evidence: ChatGptWebRoundEvidence): string {
  return JSON.stringify({
    reasoning: evidence.reasoning ?? [],
    ...(evidence.answer !== undefined ? { answer: evidence.answer } : {}),
    ...(evidence.toolRequests ? {
      tool_calls: evidence.toolRequests.map(request => ({
        call_id: request.callId,
        name: request.wireName,
        ...(request.freeform
          ? { input: request.input ?? "" }
          : { arguments: request.arguments ?? {} }),
      })),
    } : {}),
  });
}

export function estimateChatGptWebUsage(
  parsed: CodexParsedRequest,
  evidence: ChatGptWebRoundEvidence,
  capabilities: ChatGptWebCapabilities,
  experimentalBiggerContext = false,
): CodexUsage {
  const inputTokens = estimateChatGptWebInputTokens(parsed, capabilities, {
    experimentalMultipartParts: experimentalBiggerContext
      ? resolveBiggerContextMultipartParts(parsed, capabilities)
      : undefined,
  });
  const outputTokens = conservativeTextTokens(roundEvidenceText(evidence), parsed.modelId);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
