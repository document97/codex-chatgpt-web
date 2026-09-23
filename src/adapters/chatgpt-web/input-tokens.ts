import { CHATGPT_WEB_CONTEXT_ATTACHMENT_TOKEN_LIMIT, CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, chatGptWebImageTokenReserve } from "../../chatgpt-web-models";
import { estimateTokens } from "../../lib/token-estimate";
import {
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
  type ChatGptWebPromptFile,
  type CompiledChatGptWebPrompt,
} from "./prompt";

/**
 * The Free/Luna product accepted measured browser inputs at 25,400 and 28,547 estimated tokens,
 * but rejected the same shape at 32,283 before producing a response. This is a ChatGPT browser
 * transport boundary, not Luna's model context window, and applies to normal and checkpoint turns.
 */
export const CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET = 28_000;

const TOKEN_ESTIMATE_TRANSACTION = `ctx_${"0".repeat(32)}`;

export function compiledChatGptWebMessages(compiled: CompiledChatGptWebPrompt): string[] {
  if (!compiled.multipart) return [compiled.text];
  return [
    ...compiled.multipart.parts.slice(0, -1).map((payload, index) => (
      formatChatGptWebMultipartStage(
        payload,
        TOKEN_ESTIMATE_TRANSACTION,
        index + 1,
        compiled.multipart!.parts.length,
      ).text
    )),
    formatChatGptWebMultipartCommit(compiled.multipart, TOKEN_ESTIMATE_TRANSACTION),
  ];
}

export function compiledChatGptWebMaxMessageChars(compiled: CompiledChatGptWebPrompt): number {
  return Math.max(...compiledChatGptWebMessages(compiled).map(message => message.length));
}

/** Tokens present in the one visible browser message, excluding hidden product/tool reserves. */
export function estimateCompiledChatGptWebMessageTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): number {
  return Math.max(...compiledChatGptWebMessages(compiled).map(message => estimateTokens(message, modelId)));
}

export function estimateCompiledChatGptWebInputTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): number {
  const imageTokens = estimateChatGptWebImageTokens(compiled);
  const fileTokens = (compiled.files ?? []).reduce(
    (total, file) => total + (file.estimatedTokens ?? estimateChatGptWebUploadedFileTokens(file)),
    0,
  );
  const messageTokens = compiledChatGptWebMessages(compiled)
    .reduce((total, message) => total + estimateTokens(message, modelId), 0);
  const acknowledgementTokens = compiled.multipart
    ? compiled.multipart.parts.slice(0, -1).reduce((total, payload, index) => total + estimateTokens(
      formatChatGptWebMultipartStage(
        payload,
        TOKEN_ESTIMATE_TRANSACTION,
        index + 1,
        compiled.multipart!.parts.length,
      ).acknowledgement,
      modelId,
    ), 0)
    : 0;
  return CHATGPT_WEB_PLATFORM_RESERVE_TOKENS
    + messageTokens
    + acknowledgementTokens
    + imageTokens
    + fileTokens;
}

export function estimateChatGptWebImageTokens(compiled: CompiledChatGptWebPrompt): number {
  return compiled.images.reduce(
    (total, image) => total + chatGptWebImageTokenReserve(image.detail),
    0,
  );
}

/** Local path pushes carry raw base64; inline `input_file` pushes may carry a full data URL. */
function decodeUploadedFileBytes(data: string): Buffer {
  if (!data.startsWith("data:")) return Buffer.from(data, "base64");
  const comma = data.indexOf(",");
  if (comma < 0) return Buffer.alloc(0);
  const header = data.slice(0, comma);
  const payload = data.slice(comma + 1);
  if (/;base64$/i.test(header)) return Buffer.from(payload, "base64");
  try {
    return Buffer.from(decodeURIComponent(payload), "utf8");
  } catch {
    return Buffer.from(payload, "utf8");
  }
}

/**
 * User file uploads (local paths and inline `input_file` blocks) arrive as raw bytes that ChatGPT
 * parses server-side, so unlike generated textual files they carry no `estimatedTokens` and would
 * otherwise count zero against Codex's context indicator. Tier the estimate by what the bytes become
 * in the model's context: audio/video gets the same flat reserve as images (server-side media
 * handling, not raw bytes), recognized text is tokenized exactly, and binary documents fall back to
 * 4 bytes per token of extracted text, capped at the measured single-attachment ceiling so one large
 * upload cannot demand more room than ChatGPT has ever accepted through this carrier.
 */
export function estimateChatGptWebUploadedFileTokens(file: ChatGptWebPromptFile): number {
  if (file.mimeType.startsWith("audio/") || file.mimeType.startsWith("video/")) {
    return chatGptWebImageTokenReserve();
  }
  const bytes = decodeUploadedFileBytes(file.data);
  if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
    return Math.min(Math.ceil(bytes.length / 4), CHATGPT_WEB_CONTEXT_ATTACHMENT_TOKEN_LIMIT);
  }
  return estimateTokens(bytes.toString("utf8"));
}
