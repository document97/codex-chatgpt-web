import { expect, test } from "bun:test";
import { estimateChatGptWebInputTokens, chatGptWebContextYieldTokenLimit, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { CHATGPT_WEB_LUNA_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };

function request(text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

test.each([
  ["highly compressible", "a".repeat(480_000)],
  ["ordinary repeated words", `${"word ".repeat(79_999)}word`],
])("%s context uses tokenizer-derived usage without character-pressure inflation", (_label, text) => {
  expect(estimateChatGptWebInputTokens(request(text), capabilities)).toBeLessThan(100_000);
}, 15_000);

test("multipart selection accounts for whole-record and composer fit before submission", () => {
  const plus = { ...capabilities, extraHighAvailable: false, proAvailable: false };
  for (const [contents, expected] of [
    [["small task"], undefined],
    // A 50,000-token record is already past the measured 45,000-token message boundary, and the
    // bridge never splits one record, so no part count can carry it inline.
    [[50_000, 40_000, 50_000, 5_000].map(n => "word ".repeat(n)), undefined],
    // Low-density whitespace overflows the composer before tokens: two 450,000-character records
    // already saturate one visible message's composer room, so the third record needs the second part.
    [Array.from({ length: 3 }, () => " ".repeat(450_000)), 2],
  ] as const) {
    const parsed = request("");
    parsed.context.messages = contents.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const parts = resolveBiggerContextMultipartParts(parsed, plus);
    expect(parts).toBe(expected);
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: parts });
    if (parts) {
      expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
        .toEqual([...contents]);
    }
    for (const text of compiledChatGptWebMessages(compiled)) {
      expect(estimateTokens(text)).toBeLessThanOrEqual(45_000);
    }
    if (!parts && contents.length > 1) expect((compiled.files ?? []).length).toBeGreaterThan(0);
  }
  // This compiles and re-tokenizes megabyte-scale records, and the Windows runner is several times
  // slower than a developer machine; the assertions above are the contract, not the budget.
}, 180_000);

test("Bigger Context adds a part instead of planning a message ChatGPT will reject", () => {
  // Live shape: a fresh browser chat replaying 86,173 estimated input tokens in two visible
  // messages. ChatGPT accepted the 38,038-token stage and rejected the ~48,000-token final message
  // (trace 2ac87c6a0421, files=0), because the two-part plan only checked the 81,807-token input
  // room of the 90,000-token model window, not the measured 40,000-token message boundary. A
  // record set that cannot fit three sub-boundary stages takes the measured attachment carrier.
  const plus = { ...capabilities, extraHighAvailable: false, proAvailable: false };
  const parsed = request("");
  parsed.context.messages = [
    ...Array.from({ length: 4 }, (_, index) => `${"word ".repeat(20_000)}record${index}`),
    "word ".repeat(8_000),
  ].map((content, index) => ({ role: "user" as const, content, timestamp: index + 1 }));
  expect(resolveBiggerContextMultipartParts(parsed, plus)).toBeUndefined();
  const compiled = compileChatGptWebPrompt(parsed, plus);
  expect(compiled.multipart).toBeUndefined();
  expect((compiled.files ?? []).length).toBe(1);
  for (const text of compiledChatGptWebMessages(compiled)) {
    expect(estimateTokens(text)).toBeLessThanOrEqual(40_000);
  }
});

test("Bigger Context stages parts while every stage stays inside the message boundary", () => {
  const plus = { ...capabilities, extraHighAvailable: false, proAvailable: false };
  const parsed = request("");
  parsed.context.messages = Array.from({ length: 6 }, (_, index) => ({
    role: "user" as const, content: `${"word ".repeat(9_000)}record${index}`, timestamp: index + 1,
  }));
  const parts = resolveBiggerContextMultipartParts(parsed, plus);
  expect(parts).toBe(2);
  const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: parts });
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual(parsed.context.messages.map(message => message.content));
  for (const text of compiledChatGptWebMessages(compiled)) {
    expect(estimateTokens(text)).toBeLessThanOrEqual(40_000);
  }
});

test("staging refuses to spend a conversation whose cumulative inline budget is spent", () => {
  const plus = { ...capabilities, extraHighAvailable: false, proAvailable: false };
  const parsed = request("");
  parsed.context.messages = Array.from({ length: 6 }, (_, index) => ({
    role: "user" as const, content: `${"word ".repeat(9_000)}record${index}`, timestamp: index + 1,
  }));
  // Without a recorded spend the same payload stages into two parts.
  expect(resolveBiggerContextMultipartParts(parsed, plus)).toBe(2);
  // A conversation with 85k recorded inline spend has ~5k of headroom: no staged plan fits, and
  // the whole-context attachment transport carries the payload instead.
  const remaining = 90_000 - 85_000;
  expect(resolveBiggerContextMultipartParts(parsed, plus, remaining)).toBeUndefined();
  const compiled = compileChatGptWebPrompt(parsed, plus, undefined, {
    inlineConversationTokenRemaining: remaining,
  });
  expect(compiled.multipart).toBeUndefined();
  expect((compiled.files ?? []).length).toBe(1);
});

test("an inline envelope that cannot carry the bulk hands it to a generated attachment file", () => {
  // 160,000 tokens exceed three 45,000-token Plus messages, but no single record exceeds one
  // message, so staging cannot help. The attachment shape is the measured carrier: ChatGPT accepted
  // a turn whose file held 82,337 estimated tokens while it rejected a 48,141-token inline message.
  const plus = { ...capabilities, extraHighAvailable: false, proAvailable: false };
  const parsed = request("");
  parsed.context.messages = Array.from(
    { length: 4 },
    (_, index) => ({ role: "user" as const, content: `${"word ".repeat(40_000)}record${index}`, timestamp: index + 1 }),
  );
  expect(resolveBiggerContextMultipartParts(parsed, plus)).toBeUndefined();
  const compiled = compileChatGptWebPrompt(parsed, plus);
  expect(compiled.multipart).toBeUndefined();
  expect((compiled.files ?? []).length).toBe(1);
  expect(estimateTokens(compiled.text)).toBeLessThanOrEqual(45_000);
  expect((compiled.files ?? [])[0]!.estimatedTokens).toBeGreaterThan(150_000);
}, 60_000);

test("compaction over a huge history rides the whole-context attachment instead of staging", () => {
  const parsed = request("x".repeat(160_000));
  parsed._compactionRequest = true;
  // Staging cannot fit histories that outgrew the per-conversation inline boundary, and the
  // legacy 110k-byte trimmed envelope would discard most of the history the checkpoint needs.
  expect(resolveBiggerContextMultipartParts(parsed, capabilities)).toBeUndefined();
  const compiled = compileChatGptWebPrompt(parsed, capabilities);
  expect(compiled.multipart).toBeUndefined();
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect((compiled.files ?? []).length).toBe(1);
  expect(compiled.text).toContain("history-compaction checkpoint");
  expect(compiled.text).not.toContain("x".repeat(1_000));
}, 60_000);

test("multipart planning leaves room for final attachments and execution instructions without losing history", () => {
  for (const scenario of [
    { extraHighAvailable: false, proAvailable: false, images: 3, schema: false },
    { extraHighAvailable: true, proAvailable: true, images: 8, schema: false },
    { extraHighAvailable: false, proAvailable: false, images: 0, schema: true },
  ]) {
    const caps = { ...capabilities, proAvailable: scenario.proAvailable };
    const parsed = request("");
    // Every stage must fit one visible message, so the whole record set stays within three of them.
    const texts = Array.from({ length: 36 }, (_, index) => `record ${index}: ${"word ".repeat(2_500)}`);
    parsed.context.messages = texts.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const images = Array.from({ length: scenario.images }, (_, index) => ({
      type: "image" as const, imageUrl: `data:image/png;base64,partition-image-${index}`, detail: "original" as const,
    }));
    if (images.length) parsed.context.messages.push({ role: "user", content: images, timestamp: 37 });
    if (scenario.schema) parsed.options.outputFormat = {
      type: "json_schema", name: "result", strict: true, schema: { type: "string", description: "schema ".repeat(9_000) },
    };
    const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 3 });
    const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
    expect(records.map(record => record.message_index)).toEqual(parsed.context.messages.map((_, index) => index));
    expect(records.slice(0, texts.length).map(record => record.message.content)).toEqual(texts);
    expect(compiled.images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })))
      .toEqual(images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })));
    if (scenario.schema) expect(compiled.multipart!.commit).toContain(JSON.stringify(parsed.options.outputFormat!.schema));
    const messages = compiledChatGptWebMessages(compiled);
    const tokens = messages.map(text => estimateTokens(text));
    const chars = messages.map(text => text.length);
    const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
    const maxStageChars = Math.max(...chars.slice(0, -1));
    const stage = resolveChatGptWebMultipartStagingMode(parsed.modelId, caps, maxStageMessageTokens, maxStageChars);
    expect(() => assertChatGptWebMultipartInputWithinLimits(
      estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId), Math.max(...tokens),
      parsed.modelId, "high", caps, Math.max(...chars), 3,
      { stagingEffort: stage.effort, maxStageMessageTokens, maxStageChars, finalMessageTokens: tokens[2]!, finalMessageChars: chars[2]!, finalImageTokens: estimateChatGptWebImageTokens(compiled) },
    )).not.toThrow();
  }
}, 30_000);

test("the yield line spends only the reserve-free part of the product context limit", () => {
  // The yield line is computed from the backend model id; the visible `chatgpt-web/high` slug is
  // already resolved to model + effort before a request reaches the adapter.
  const web = request("small task");
  const plus = { ...capabilities, proAvailable: false };
  // Plus high compacts at 80,000; the handoff round itself keeps a 10% reserve.
  expect(chatGptWebContextYieldTokenLimit(web, plus, false)).toBe(80_000 - 8_000);
  // Bigger Context triples only the transport window; the yield line rises to the measured staged
  // budget (90,000 minus its 10% reserve) so the turn still hands off before the browser fails
  // (2026-09-23 incident).
  expect(chatGptWebContextYieldTokenLimit(web, plus, true)).toBe(90_000 - 9_000);
  expect(chatGptWebContextYieldTokenLimit(web, capabilities, false)).toBe(95_000 - 9_500);
  // Luna carries history through its own checkpoint and Zero Risk has no bridge-driven continuation.
  expect(chatGptWebContextYieldTokenLimit(
    { ...request("small task"), modelId: CHATGPT_WEB_LUNA_MODEL_ID }, capabilities, false,
  )).toBeUndefined();
});

test("file attachments join the context-ring estimate instead of counting as zero", () => {
  const baseline = estimateChatGptWebInputTokens(request("summarize the attachment"), capabilities);
  const withFile = (filename: string, fileData: string): number => {
    const parsed = request("summarize the attachment");
    parsed.context.messages.push({
      role: "user",
      content: [
        { type: "text", text: "summarize the attachment" },
        { type: "file", filename, fileData },
      ],
      timestamp: 3,
    });
    return estimateChatGptWebInputTokens(parsed, capabilities) - baseline;
  };

  // Recognized text is tokenized exactly; the file_attachment record rides along for free.
  const body = `attachment body ${"word ".repeat(4_000)}`;
  expect(withFile("notes.md", `data:text/markdown;base64,${Buffer.from(body).toString("base64")}`))
    .toBeGreaterThanOrEqual(estimateTokens(body));

  // Binary documents fall back on 4 bytes per token and stop at the 82,000 single-attachment
  // ceiling: 400,000 bytes would be 100,000 tokens if left uncapped.
  const pdfGrowth = withFile("scan.pdf", `data:application/pdf;base64,${Buffer.alloc(400_000, 0x80).toString("base64")}`);
  expect(pdfGrowth).toBeGreaterThanOrEqual(82_000);
  expect(pdfGrowth).toBeLessThan(83_500);

  // Media is a flat composer reserve like images, not a function of raw byte length.
  const audioGrowth = withFile("clip.mp3", `data:audio/mpeg;base64,${Buffer.from([0xFF, 0xFB, 0x90, 0x64]).toString("base64")}`);
  expect(audioGrowth).toBeGreaterThanOrEqual(1_024);
  expect(audioGrowth).toBeLessThan(2_500);
});
