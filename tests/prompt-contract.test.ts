import { explicitCompletionRecoveryPrompt } from "../src/adapters/chatgpt-web/index";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET,
  CHATGPT_BIGGER_CONTEXT_PARTS,
  chatGptPromptJsonBytes,
  chatGptReadOnlyContextWarning,
  compileChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
  withoutRetiredTurnHandles,
} from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import { biggerContextPartCount } from "../src/adapters/chatgpt-web/usage";
import type { CodexParsedRequest } from "../src/types";

function request(reasoning: "low" | "medium" | "high" | "xhigh" | "max"): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        { role: "developer", content: "preserve-developer", timestamp: 1 },
        { role: "user", content: "perform the task", timestamp: 2 },
      ],
    },
    stream: true,
    options: { reasoning },
  };
}

test("history handle cleanup works on decoded text and preserves native call identities", () => {
  const call = `call_${"A".repeat(32)}`;
  const context = {
    tool_call_id: call,
    content: ["turn", "request", "binding"].map(kind => `first line\n${kind}_${"B".repeat(32)}\tlast line`),
    ordinary: [`my_turn_${"C".repeat(32)}`, `turn_${"D".repeat(33)}`, `turn_${"E".repeat(31)}`],
    literal: "Keep \\\\path, \\\"quotes\\\", and $& exactly.",
  };
  const cleaned = JSON.parse(withoutRetiredTurnHandles(JSON.stringify(context)));
  expect(cleaned.content).toEqual(["turn", "request", "binding"].map(kind => `first line\n[retired ${kind} handle]\tlast line`));
  expect(cleaned.tool_call_id).toBe(call);
  expect(cleaned.ordinary).toEqual(context.ordinary);
  expect(cleaned.literal).toBe(context.literal);
});

test("Full-mode Pro prompts pass one stable turn token directly to native actions", () => {
  const token = "turn_12345678901234567890123456789012";
  const parsed = request("max");
  parsed.context.messages[1]!.content = `Diagnose an invalid binding_id safety failure without replaying ${token}`;
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    token,
  );
  const envelopeEnd = compiled.text.indexOf("</codex_context_json>");
  const resume = compiled.text.indexOf("<codex_transport_resume>", envelopeEnd);
  const tokenMatches = compiled.text.match(new RegExp(token, "g"));
  const transportOnly = compiled.text.replace(
    /<codex_context_json>[\s\S]*<\/codex_context_json>/,
    "<codex_context_json>[task context]</codex_context_json>",
  );

  expect(envelopeEnd).toBeGreaterThan(0);
  expect(resume).toBeGreaterThan(envelopeEnd);
  expect(tokenMatches).toHaveLength(2);
  expect(compiled.text).toContain("[retired turn handle]");
  expect(transportOnly).toContain("For local work required by the task, use the attached Codex Native tools directly according to their declared descriptions and schemas.");
  expect(transportOnly).toContain("Call a Codex Native tool only when the latest active request requires a local effect or fresh local evidence that is not already present in the supplied context; otherwise answer the request directly without a tool call.");
  expect(transportOnly).toContain("Use actual Codex Native results as evidence for local observations and effects.");
  expect(transportOnly).toContain("A Codex Native MCP tool result may require context compaction. If it does, follow the compaction instructions in that result exactly.");
  expect(transportOnly).toContain("After a deterministic tool failure, update the working hypothesis from that result");
  expect(transportOnly).toContain("do not repeat the same call unless its inputs or observable state changed.");
  expect(transportOnly).toContain("Continue using the available tools until the requested work is complete and verified.");
  expect(transportOnly).toContain("Write the user-facing final answer only after the last required tool result has settled.");
  expect(transportOnly).toContain(`The task context is complete. Pass turn_token ${token} unchanged to every Codex Native call in this response, including continuations after tool results; do not expose it in the answer. Execute the latest active user request now.`);
  expect(transportOnly).not.toMatch(/codex_bind_turn|outer_tool_gateway|command_tool/);
  expect(transportOnly).toContain("Use codex_tool_inventory to discover the current tools and their schemas");
  expect(transportOnly).toContain("use codex_write_stdin to poll that session");
  expect(transportOnly).toContain("instead of ending with a promise or a next-step list");
  expect(transportOnly).not.toMatch(/codex_apply_patch|codex_view_image|codex\.control\.turn_complete/);
  expect(transportOnly).not.toMatch(/expired|revoked|blocked|security layer|permission gate/i);
  expect(compiled.text).not.toContain("CODEX_INTERNAL_CONTEXT_COMPACT");
  expect(compiled.text).not.toContain("internally compacts this response");
});

test("Pro preserves the same native Codex delegation contract as Extra High", () => {
  const token = "turn_12345678901234567890123456789012";
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const pro = compileChatGptWebPrompt(request("max"), capabilities, token);
  const extraHigh = compileChatGptWebPrompt(request("xhigh"), capabilities, token);

  for (const compiled of [pro, extraHigh]) {
    expect(compiled.text).toContain("For local work required by the task, use the attached Codex Native tools directly according to their declared descriptions and schemas.");
    expect(compiled.text).toContain(`Pass turn_token ${token} unchanged to every Codex Native call in this response`);
    expect(compiled.text).not.toContain("Complete this task directly in the current parent response.");
    expect(compiled.text).not.toContain("Do not create, spawn, delegate to, or wait on sub-agents");
    expect(compiled.text).not.toContain("Use non-agent tools directly instead.");
  }
});

test("automatic Full mode requires an explicit completed answer instead of accepting progress text", () => {
  const compiled = compileChatGptWebPrompt(
    request("high"),
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
    { explicitCompletion: true },
  );
  expect(compiled.text).toContain("Ordinary assistant text is progress commentary");
  expect(compiled.text).toContain("call codex_turn_complete exactly once");
  expect(compiled.text).toContain("Do not call it with a progress report, future plan, or promise to continue");
});

test("read-only prompts resume without exposing a bind capability", () => {
  const compiled = compileChatGptWebPrompt(
    request("max"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("The task context is complete. Execute the latest active user request now under the capability contract above.");
  expect(compiled.text).not.toContain("codex_bind_turn");
  expect(compiled.text).not.toContain("turn_token");
  expect(compiled.text).toContain("web search, browsing, research");
  expect(compiled.text).toContain("The missing local-computer bridge says nothing about whether those ChatGPT capabilities are available");
  expect(compiled.text).not.toContain("No local computer tool, MCP app");
  expect(compiled.text).not.toContain("evidence inside");
  expect(compiled.text).toContain("Do not mention this transport contract, context packaging, or capability routing");
  expect(compiled.text).not.toContain("CODEX_INTERNAL_CONTEXT_COMPACT");
});

test("Bigger Context sends three semantic record envelopes and starts work from the final part", () => {
  const token = "turn_12345678901234567890123456789012";
  const parsed = request("high");
  parsed.context.systemPrompt = ["system-one", "system-two"];
  parsed.context.messages.push(
    { role: "assistant", content: [{ type: "text", text: "prior-answer" }], timestamp: 3 },
    { role: "user", content: "latest-request", timestamp: 4 },
  );
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    token,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );

  expect(compiled.multipart?.parts).toHaveLength(3);
  const records = compiled.multipart!.parts.flatMap(part => {
    const payload = JSON.parse(part) as { version: number; records: unknown[] };
    expect(payload.version).toBe(1);
    return payload.records;
  }) as Array<Record<string, unknown>>;
  expect(records.filter(record => record.kind === "system").map(record => record.content)).toEqual([
    "system-one",
    "system-two",
  ]);
  expect(records.filter(record => record.kind === "message").map(record => (
    (record.message as { role: string }).role
  ))).toEqual(["developer", "user", "assistant", "user"]);
  expect(compiled.multipart!.parts.join("\n")).not.toContain(token);
  expect(compiled.multipart!.commit.match(new RegExp(token, "g"))).toHaveLength(1);
  expect(compiled.text).toBe(compiled.multipart!.commit);
  expect(compiled.text).not.toContain("<codex_context_json>");

  const transactionId = `ctx_${"a".repeat(32)}`;
  const stages = compiled.multipart!.parts.slice(0, -1).map((part, index) => (
    formatChatGptWebMultipartStage(part, transactionId, index + 1)
  ));
  expect(stages).toHaveLength(2);
  for (const [index, stage] of stages.entries()) {
    expect(stage.text).toContain(`part: ${index + 1}/3`);
    expect(stage.text).toContain(stage.sha256);
    expect(stage.acknowledgement).toBe(
      `CODEX_MULTIPART_ACK ${transactionId} ${index + 1}/3 ${stage.sha256}`,
    );
    expect(stage.text).toContain("```json\n");
    expect(stage.text).toContain("<codex_multipart_stage_end>");
    expect(stage.text).toEndWith("</codex_multipart_stage_end>");
    expect(stage.text.lastIndexOf(stage.acknowledgement)).toBeGreaterThan(
      stage.text.indexOf("</codex_context_part_json>"),
    );
  }
  const commit = formatChatGptWebMultipartCommit(compiled.multipart!, transactionId);
  expect(commit).toContain(`transaction_id: ${transactionId}`);
  expect(commit).toContain("acknowledged_parts: 2/3");
  expect(commit).toContain("The final part is included in this same message and starts the task");
  expect(commit).toContain(compiled.multipart!.parts[2]!);
  expect(commit).toContain("latest-request");
  expect(commit.match(new RegExp(token, "g"))).toHaveLength(1);
});

test("Bigger Context uses the minimum transport and reserves three stages for compaction", () => {
  expect(biggerContextPartCount(94_999, 95_000, false)).toBeUndefined();
  expect(biggerContextPartCount(95_000, 95_000, false)).toBe(2);
  expect(biggerContextPartCount(189_999, 95_000, false)).toBe(2);
  expect(biggerContextPartCount(190_000, 95_000, false)).toBe(3);
  expect(biggerContextPartCount(1, 95_000, true)).toBe(3);

  const compiled = compileChatGptWebPrompt(
    request("high"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    undefined,
    { experimentalMultipartParts: 2 },
  );
  expect(compiled.multipart?.parts).toHaveLength(2);
  const transactionId = `ctx_${"b".repeat(32)}`;
  const stages = compiled.multipart!.parts.slice(0, -1).map((part, index) => (
    formatChatGptWebMultipartStage(part, transactionId, index + 1, 2)
  ));
  expect(stages).toHaveLength(1);
  expect(stages.map(stage => stage.acknowledgement)).toEqual([
    `CODEX_MULTIPART_ACK ${transactionId} 1/2 ${stages[0]!.sha256}`,
  ]);
  expect(formatChatGptWebMultipartCommit(compiled.multipart!, transactionId))
    .toContain("acknowledged_parts: 1/2");
});

test("browser-only Medium directs users to the full harness", () => {
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const warning = chatGptReadOnlyContextWarning(request("medium"), capabilities);
  expect(warning).toStartWith("> **Local tools unavailable**");
  expect(warning).toContain("`MCP`");
  expect(warning).toContain("`Codex Web GPT`");
  expect(warning).toContain("`Full`");
  expect(warning).toContain("selected ChatGPT Web model");
  expect(warning).not.toContain("tool-capable ChatGPT Web model first");
  expect(chatGptReadOnlyContextWarning(request("medium"), {
    ...capabilities,
    localToolsEnabled: true,
  })).toBeUndefined();
});

test("compaction prompts are isolated summarization turns without local or native tool instructions", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("This is a Codex history-compaction checkpoint, not a normal task turn.");
  expect(compiled.text).toContain("Produce the requested checkpoint summary now without calling tools.");
  expect(compiled.text).not.toContain("codex_bind_turn");
  expect(compiled.text).not.toContain("web search, browsing, research");
  expect(compiled.text).not.toContain("missing local-computer bridge");
});

test("Web compaction over the inline budget rides the whole-context attachment without trimming", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [
    { role: "developer", content: `oldest-static-${"a".repeat(10_000)}`, timestamp: 1 },
    { role: "developer", content: `newer-static-${"b".repeat(10_000)}`, timestamp: 2 },
    { role: "user", content: `real-task-${"c".repeat(100_000)}`, timestamp: 3 },
    {
      role: "assistant",
      content: [{ type: "text", text: "verified-progress" }],
      timestamp: 4,
    },
    { role: "user", content: "checkpoint-now", timestamp: 5 },
  ];

  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  // The measured inline boundary cannot carry this history. Trimming would discard history the
  // checkpoint needs, so the complete context rides the generated attachment file instead.
  expect((compiled.files ?? []).length).toBe(1);
  expect(compiled.files![0]!.name).toBe("codex-context.json");
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.text).not.toContain("real-task-");
  const envelope = JSON.parse(Buffer.from(compiled.files![0]!.data, "base64").toString("utf8")) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  const serialized = JSON.stringify(envelope.messages);
  expect(serialized).toContain("oldest-static-");
  expect(serialized).toContain("newer-static-");
  expect(serialized).toContain("real-task-");
  expect(serialized).toContain("verified-progress");
  expect(envelope.messages.at(-1)).toEqual({ role: "user", content: "checkpoint-now" });

  const normal = structuredClone(compact);
  delete normal._compactionRequest;
  const untrimmed = compileChatGptWebPrompt(
    normal,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );
  expect((untrimmed.files ?? []).length).toBe(1);
  expect(untrimmed.trimmedCompactionMessages).toBeUndefined();
});

test("compaction carries the newest cumulative checkpoint and the full history via the attachment", () => {
  for (const textParts of [false, true]) {
    const compact = request("high");
    compact._compactionRequest = true;
    compact.context.systemPrompt = [];
    const checkpoint = `${SUMMARY_PREFIX}\n\nVerified cumulative scope: ${"s".repeat(20_000)}`;
    compact.context.messages = [
      { role: "user", content: `${SUMMARY_PREFIX}\nObsolete summary`, timestamp: 1 },
      { role: "user", content: textParts ? [{ type: "text", text: checkpoint }] : checkpoint, timestamp: 2 },
      { role: "toolResult", toolCallId: "old-output", toolName: "read", isError: false,
        content: [{ type: "text", text: "x".repeat(100_000) }, { type: "image", imageUrl: "data:image/png;base64,old-image" }], timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "recent verified progress" }], timestamp: 4 },
      { role: "user", content: "checkpoint-now", timestamp: 5 },
    ];
    const before = structuredClone(compact);
    const compiled = compileChatGptWebPrompt(compact, {
      localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
    });
    // Nothing is discarded: the attachment carries the complete history including the superseded
    // summary and the oversized tool output, so the checkpoint summarizes the real full scope.
    expect((compiled.files ?? []).length).toBe(1);
    expect(compiled.trimmedCompactionMessages).toBeUndefined();
    expect(compiled.text).not.toContain("x".repeat(1_000));
    const envelope = JSON.parse(Buffer.from(compiled.files![0]!.data, "base64").toString("utf8")) as {
      messages: Array<{ role: string }>;
    };
    expect(envelope.messages.length).toBeGreaterThanOrEqual(4);
    const serialized = JSON.stringify(envelope.messages);
    // The opaque-note conversion wraps summary-prefixed messages and keeps their inner content.
    expect(serialized).toContain("ssssssssssssssssss");
    expect(serialized).toContain("checkpoint-now");
    expect(compiled.text).toContain("history-compaction checkpoint");
    expect(chatGptPromptJsonBytes(compiled.text)).toBeLessThanOrEqual(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
    expect(compact).toEqual(before);
    const manual = compileChatGptWebPrompt(compact, {
      localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true,
    }, "turn_12345678901234567890123456789012", { manualControl: true });
    // Zero Risk has no generated-attachment transport: the legacy trimmed inline envelope applies.
    expect(manual.text).toContain("ssssssssssssssssss");
    expect(manual.text).toContain("history is incomplete");
    expect(manual.text).not.toContain("without calling tools");
    expect(chatGptPromptJsonBytes(manual.text)).toBeLessThanOrEqual(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
  }
});

test("compaction preserves an oversized required checkpoint via the attachment instead of failing", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [
    { role: "user", content: `${SUMMARY_PREFIX}\n${"s".repeat(120_000)}`, timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "recent progress" }], timestamp: 2 },
    { role: "user", content: "checkpoint-now", timestamp: 3 },
  ];
  const compiled = compileChatGptWebPrompt(compact, {
    localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
  });
  expect((compiled.files ?? []).length).toBe(1);
  const envelope = JSON.parse(Buffer.from(compiled.files![0]!.data, "base64").toString("utf8")) as {
    messages: Array<{ content: unknown }>;
  };
  expect(JSON.stringify(envelope.messages)).toContain("ssssssssssssssssss");
  expect(JSON.stringify(envelope.messages)).toContain("checkpoint-now");
});

test("Bigger Context compaction preserves history above the retired inline byte budget", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = Array.from({ length: 6 }, (_unused, index) => ({
    role: "user" as const,
    content: `multipart-history-${index + 1}-${String.fromCharCode(97 + index).repeat(160_000)}`,
    timestamp: index + 1,
  }));

  const multipart = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    undefined,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );

  expect(multipart.trimmedCompactionMessages).toBeUndefined();
  expect(multipart.multipart?.parts).toHaveLength(3);
  const transactionId = `ctx_${"0".repeat(32)}`;
  const stageBytes = multipart.multipart!.parts.map((payload, index) => chatGptPromptJsonBytes(
    formatChatGptWebMultipartStage(payload, transactionId, index + 1).text,
  ));
  expect(Math.max(...stageBytes)).toBeGreaterThan(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
  const staged = multipart.multipart!.parts.join("\n");
  for (let index = 1; index <= 6; index += 1) {
    expect(staged).toContain(`multipart-history-${index}-`);
  }
}, 30_000);

test("Bigger Context minimizes the largest ordered stage instead of overfilling a middle part", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = ["system".repeat(1_000)];
  compact.context.messages = [
    ...Array.from({ length: 3 }, (_unused, index) => ({
      role: "user" as const,
      content: `history-${index}-${"x".repeat(100_000)}`,
      timestamp: index + 1,
    })),
    { role: "user", content: "compact now", timestamp: 4 },
  ];

  const multipart = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    undefined,
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );
  const parts = multipart.multipart!.parts.map(part => JSON.parse(part) as { records: unknown[] });

  expect(parts.map(part => part.records.length)).toEqual([2, 1, 2]);
  expect(Math.max(...multipart.multipart!.parts.map(part => part.length))).toBeLessThan(120_000);
});

test("Web compaction keeps the oversized oldest image message via the attachment", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [
    {
      role: "user",
      content: [
        { type: "text", text: `discard-${"x".repeat(120_000)}` },
        { type: "image", imageUrl: "data:image/png;base64,discarded-image" },
      ],
      timestamp: 1,
    },
    { role: "user", content: "preserve-latest-checkpoint", timestamp: 2 },
  ];

  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect((compiled.files ?? []).length).toBe(1);
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.text).not.toContain("discard-");
  const envelope = JSON.parse(Buffer.from(compiled.files![0]!.data, "base64").toString("utf8")) as {
    messages: Array<{ content: unknown }>;
  };
  expect(JSON.stringify(envelope.messages)).toContain("discard-");
  expect(JSON.stringify(envelope.messages)).toContain("image_attachment");
  expect(JSON.stringify(envelope.messages)).toContain("preserve-latest-checkpoint");
});

test("Web compaction carries a huge final instruction via the attachment instead of failing", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.systemPrompt = [];
  compact.context.messages = [{ role: "user", content: "z".repeat(120_000), timestamp: 1 }];

  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );
  expect((compiled.files ?? []).length).toBe(1);
  const envelope = JSON.parse(Buffer.from(compiled.files![0]!.data, "base64").toString("utf8")) as {
    messages: Array<{ content: unknown }>;
  };
  expect(JSON.stringify(envelope.messages)).toContain("z".repeat(1_000));
  expect(chatGptPromptJsonBytes(compiled.text)).toBeLessThanOrEqual(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
});

test("assigns prior assistant output to the model and never attributes Codex context to the human", () => {
  const attributed = request("max");
  attributed.context.messages = [
    { role: "user", content: "hi", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "Hi! How can I help?" }],
      timestamp: 2,
    },
    {
      role: "user",
      content: "what did I write before?\n<environment_context><cwd>/private/project</cwd></environment_context>",
      timestamp: 3,
    },
  ];
  const compiled = compileChatGptWebPrompt(
    attributed,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );
  const encoded = compiled.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)?.[1];
  const envelope = JSON.parse(encoded!) as { messages: Array<Record<string, unknown>> };

  expect(envelope.messages[1]).toEqual({
    role: "assistant",
    content: [{ type: "text", text: "Hi! How can I help?" }],
  });
  expect(compiled.text).toContain("assistant messages are your own earlier replies");
  expect(compiled.text).toContain("environment_context, are operational context rather than human-authored text");
  expect(compiled.text).toContain("answer only from the human-authored text in user messages");
  expect(compiled.text).toContain("do not attribute, quote, summarize, or otherwise mention them");
});

test("a long task keeps the newest images and drops the overflow instead of failing", () => {
  const image = (marker: string) => ({
    type: "image" as const,
    imageUrl: `data:image/png;base64,${marker}`,
  });
  const markers = Array.from({ length: 13 }, (_unused, index) => `IMG${index + 1}`);
  const replayed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: markers.map((marker, index) => ({
        role: "user" as const,
        content: [{ type: "text" as const, text: `step ${index + 1}` }, image(marker)],
        timestamp: index + 1,
      })),
    },
    stream: true,
    options: { reasoning: "high" },
  };

  const compiled = compileChatGptWebPrompt(
    replayed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );

  expect(compiled.images.map(entry => entry.imageUrl)).toEqual(
    markers.slice(-8).map(marker => `data:image/png;base64,${marker}`),
  );
  expect(compiled.text).toContain("older image not attached");
  expect(compiled.text).toContain("step 1");
  expect(compiled.text).toContain("step 13");
});

test("Web compaction attaches the newest eight images as files and never embeds their base64 in prompt text", () => {
  const imagePayloads = Array.from({ length: 13 }, (_unused, index) =>
    Buffer.from(`compaction-image-${index + 1}`).toString("base64"));
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: imagePayloads.map((payload, index) => ({
        role: "user" as const,
        content: [
          { type: "text" as const, text: `checkpoint ${index + 1}` },
          { type: "image" as const, imageUrl: `data:image/png;base64,${payload}` },
        ],
        timestamp: index + 1,
      })),
    },
    stream: true,
    options: { reasoning: "high" },
    _compactionRequest: true,
  };

  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.images.map(image => image.imageUrl)).toEqual(
    imagePayloads.slice(-8).map(payload => `data:image/png;base64,${payload}`),
  );
  expect(compiled.text).not.toContain("data:image");
  for (const payload of imagePayloads) expect(compiled.text).not.toContain(payload);
  expect(compiled.text.match(/"type":"image_attachment"/g)).toHaveLength(8);
  expect(compiled.text.match(/older image not attached/g)).toHaveLength(5);
});

test("persisted one-pixel image sentinels are not attached to ChatGPT", () => {
  const placeholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "inspect the real image" },
          ...Array.from({ length: 30 }, () => ({ type: "image" as const, imageUrl: placeholder })),
          { type: "image", imageUrl: "data:image/png;base64,real-image" },
        ],
        timestamp: 1,
      }],
    },
    stream: true,
    options: { reasoning: "high" },
  };

  const compiled = compileChatGptWebPrompt(parsed, { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true });

  expect(compiled.images.map(image => image.imageUrl)).toEqual(["data:image/png;base64,real-image"]);
  expect(compiled.text.match(/"type":"image_attachment"/g)).toHaveLength(1);
  expect(compiled.text).not.toContain("older image not attached");
});

test("plain text turns do not request an attachment retention manifest", () => {
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    stream: true,
    options: { reasoning: "high" },
  };

  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).not.toContain("codex_attachment_retention");
});

test("the previous model retention manifest selects historical attachments for a fresh page", () => {
  const first = "data:image/png;base64,aGlzdG9yeS1maXJzdA==";
  const second = "data:image/png;base64,aGlzdG9yeS1zZWNvbmQ=";
  const initial: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "compare these" },
          { type: "image", imageUrl: first },
          { type: "image", imageUrl: second },
        ],
        timestamp: 1,
      }],
    },
    stream: true,
    options: { reasoning: "high" },
  };
  const initialCompiled = compileChatGptWebPrompt(
    initial,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );
  const retentionIds = [...initialCompiled.text.matchAll(/"retention_id":"(att_[a-f0-9]{16})"/g)]
    .map(match => match[1]!);
  expect(retentionIds).toHaveLength(2);

  const continued: CodexParsedRequest = {
    ...initial,
    context: {
      messages: [
        initial.context.messages[0]!,
        {
          role: "assistant",
          content: [{ type: "text", text: `Result\n<!--codex\\_attachment\\_retention:\\["${retentionIds[1]!.replace("_", "\\_")}"\\]-->` }],
          timestamp: 2,
        },
        { role: "user", content: "continue with the useful one", timestamp: 3 },
      ],
    },
  };
  const compiled = compileChatGptWebPrompt(
    continued,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.images.map(image => image.imageUrl)).toEqual([second]);
  expect(compiled.attachmentNotices?.join(" ")).toContain("previous model retention decision");
});

test("the replayed context never carries a finished turn's broker handles", () => {
  const staleToken = "turn_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const staleBinding = "binding_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const token = "turn_12345678901234567890123456789012";
  const replayed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        { role: "user", content: "keep working", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "codex_bind_turn", arguments: { turn_token: staleToken } }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "codex_bind_turn",
          isError: false,
          content: `{"binding_id":"${staleBinding}"}`,
          timestamp: 3,
        },
      ],
    },
    stream: true,
    options: { reasoning: "high" },
  };

  const compiled = compileChatGptWebPrompt(replayed, { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true }, token);

  expect(compiled.text).not.toContain(staleToken);
  expect(compiled.text).not.toContain(staleBinding);
  expect(compiled.text).toContain("[retired turn handle]");
  expect(compiled.text).toContain("[retired binding handle]");
  expect(compiled.text).toContain(token);
  expect(compiled.text).toContain("keep working");
  const envelope = compiled.text.split("<codex_context_json>")[1]!.split("</codex_context_json>")[0]!.trim();
  expect(() => JSON.parse(envelope) as unknown).not.toThrow();
});

test("requires ChatGPT-native rich results to include a safe Markdown answer for Codex", () => {
  const compiled = compileChatGptWebPrompt(
    request("max"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("also provide the relevant result as ordinary Markdown in the final answer");
  expect(compiled.text).toContain("A private ChatGPT UI widget never replaces the Markdown answer returned to Codex");
  expect(compiled.text).toContain("Never copy a ChatGPT widget's HTML, CSS, class names, or DOM markup");
});

test("uses the public Instant name without leaking the browser menu alias into the prompt", () => {
  const compiled = compileChatGptWebPrompt(
    request("low"),
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).toContain("This is ChatGPT Web Instant with no Codex Native bridge to the user's local computer");
  expect(compiled.text).not.toContain("Instant 5.5");
});

test("moves one oversized text record into a generated attachment without losing its content", () => {
  const token = "turn_12345678901234567890123456789012";
  const largeContent = "x".repeat(600_000);
  const large = request("high");
  large.context.messages.push({
    role: "toolResult",
    toolCallId: "call_large",
    toolName: "exec_command",
    content: largeContent,
    isError: false,
    timestamp: 3,
  });
  const compiled = compileChatGptWebPrompt(
    large,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    token,
  );

  expect(compiled.text.length).toBeLessThan(600_000);
  expect(compiled.text).not.toContain(largeContent);
  expect(compiled.text).toContain(token);
  expect(compiled.text).toContain(`<codex_context_json>`);
  expect(compiled.text).not.toContain(`<codex_context_attachment>`);
  expect(compiled.text).toContain('"type":"text_attachment"');
  expect(compiled.files?.map(file => file.name)).toEqual(["codex-long-text.txt"]);
  const uploaded = Buffer.from(compiled.files![0]!.data, "base64").toString("utf8");
  expect(uploaded).toContain(largeContent);
});

test("moves a large accumulated context into one JSON attachment without compacting history", () => {
  const token = "turn_12345678901234567890123456789012";
  const large = request("high");
  const contents = Array.from({ length: 8 }, (_, index) => `record-${index}:${"x".repeat(60_000)}`);
  large.context.messages = contents.map((content, index) => ({
    role: "user" as const,
    content,
    timestamp: index + 1,
  }));

  const compiled = compileChatGptWebPrompt(
    large,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    token,
  );

  expect(compiled.text.length).toBeLessThan(400_000);
  expect(compiled.text).toContain(`<codex_context_attachment>`);
  expect(compiled.text).not.toContain(`<codex_context_json>`);
  expect(compiled.files?.map(file => file.name)).toEqual(["codex-context.json"]);
  const uploaded = JSON.parse(Buffer.from(compiled.files![0]!.data, "base64").toString("utf8"));
  expect(uploaded.messages.map((message: { content: string }) => message.content)).toEqual(contents);
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
});

test("moves a browser-rejected mid-size context into an attachment before submission", () => {
  const parsed = request("high");
  parsed.context.messages = Array.from({ length: 3 }, (_, index) => ({
    role: "user" as const,
    content: `record-${index}:${"x".repeat(48_000)}`,
    timestamp: index + 1,
  }));

  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );

  expect(compiled.text.length).toBeLessThan(120_000);
  expect(compiled.text).toContain("<codex_context_attachment>");
  expect(compiled.files?.map(file => file.name)).toEqual(["codex-context.json"]);
  expect(compiled.text).not.toContain("<codex_context_json>");
});

test("R1: inline prompts close with the verbatim latest human request", () => {
  const compiled = compileChatGptWebPrompt(
    request("high"),
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );

  expect(compiled.text).toContain("<codex_latest_user_request>");
  expect(compiled.text).toContain("perform the task");
  expect(compiled.text.indexOf("<codex_latest_user_request>"))
    .toBeGreaterThan(compiled.text.indexOf("</codex_transport_resume>"));
  expect(compiled.text.trimEnd().endsWith("</codex_latest_user_request>")).toBe(true);
});

test("R1: attachment transport still pins the verbatim latest human request at the message tail", () => {
  const large = request("high");
  const contents = Array.from({ length: 8 }, (_, index) => `record-${index}:${"x".repeat(60_000)}`);
  large.context.messages = contents.map((content, index) => ({
    role: "user" as const,
    content,
    timestamp: index + 1,
  }));

  const compiled = compileChatGptWebPrompt(
    large,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );

  expect(compiled.text).toContain("<codex_context_attachment>");
  expect(compiled.text).toContain("<codex_latest_user_request>");
  // The newest record is 60k characters: the pinned request is truncated to its 8,000-char head.
  expect(compiled.text).toContain(`record-7:${"x".repeat(7_991)}`);
  expect(compiled.text).toContain("[truncated; full request remains in the task context above]");
  expect(compiled.text).not.toContain(`record-6:${"x".repeat(200)}`);
  expect(compiled.text.trimEnd().endsWith("</codex_latest_user_request>")).toBe(true);
});

test("R1: Codex scaffolding messages are never selected as the latest human request", () => {
  const parsed = request("high");
  parsed.context.messages = [
    { role: "user", content: "perform the genuine task", timestamp: 1 },
    { role: "user", content: "<environment_context>\n<cwd>C:\\repo</cwd>\n</environment_context>", timestamp: 2 },
    { role: "user", content: `${SUMMARY_PREFIX}\n\nEarlier summary of completed work.`, timestamp: 3 },
    { role: "user", content: "<turn_aborted>\nThe previous turn was interrupted.\n</turn_aborted>", timestamp: 4 },
    { role: "user", content: "<recommended_plugins>\n[]\n</recommended_plugins>", timestamp: 5 },
  ];

  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );

  const r1 = compiled.text.slice(compiled.text.indexOf("<codex_latest_user_request>"));
  expect(r1).toContain("perform the genuine task");
  expect(r1).not.toContain("environment_context");
  expect(r1).not.toContain("turn_aborted");
  expect(r1).not.toContain("recommended_plugins");
  expect(r1).not.toContain("Earlier summary of completed work");
});

test("R1: an over-long latest request is truncated to 8,000 characters with a note", () => {
  const parsed = request("high");
  const instruction = `rebuild-${"y".repeat(9_000)}`;
  parsed.context.messages.push({ role: "user", content: instruction, timestamp: 3 });

  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );

  const r1 = compiled.text.slice(compiled.text.indexOf("<codex_latest_user_request>"));
  expect(r1).toContain(`rebuild-${"y".repeat(7_992)}`);
  expect(r1).toContain("[truncated; full request remains in the task context above]");
  expect(r1).not.toContain("y".repeat(8_100));
});

test("R1: compaction rounds never carry the latest-user-request block", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );

  expect(compiled.text).not.toContain("<codex_latest_user_request>");
});

test("R1: a Bigger Context commit closes with the verbatim latest human request", () => {
  const parsed = request("high");
  parsed.context.messages.push(
    { role: "assistant", content: [{ type: "text", text: "prior-answer" }], timestamp: 3 },
    { role: "user", content: "latest-request", timestamp: 4 },
  );
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS },
  );

  expect(compiled.multipart?.commit).toContain("<codex_latest_user_request>");
  expect(compiled.multipart?.commit).toContain("latest-request");
  expect(compiled.multipart!.commit.trimEnd().endsWith("</codex_latest_user_request>")).toBe(true);
  for (const part of compiled.multipart!.parts.slice(0, -1)) {
    expect(part).not.toContain("<codex_latest_user_request>");
  }
});

test("R1: the resume nudge pins the canonical instruction through the override, or none at all", () => {
  const nudge = request("high");
  nudge.context.messages = [{
    role: "user",
    content: "The user resumed this Codex task. Continue the unfinished work from this conversation's existing context.",
    timestamp: 3,
  }];

  const anchored = compileChatGptWebPrompt(
    nudge,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
    { latestUserRequest: "query the supported upload attachment kinds" },
  );
  const r1 = anchored.text.slice(anchored.text.indexOf("<codex_latest_user_request>"));
  expect(r1).toContain("query the supported upload attachment kinds");
  expect(r1).not.toContain("Continue the unfinished work");

  const suppressed = compileChatGptWebPrompt(
    nudge,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
    { latestUserRequest: null },
  );
  expect(suppressed.text).not.toContain("<codex_latest_user_request>");
});

test("R5: attachment transport without a determinable latest human request fails explicitly", () => {
  const parsed = request("high");
  parsed.context.messages = Array.from({ length: 3 }, (_, index) => ({
    role: "user" as const,
    content: `<environment_context>\n${"x".repeat(48_000)}\n</environment_context>`,
    timestamp: index + 1,
  }));

  let failure: unknown;
  try {
    compileChatGptWebPrompt(
      parsed,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "turn_12345678901234567890123456789012",
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    name: "ChatGptWebAdapterError",
    code: "latest_user_request_unavailable",
    retryable: false,
  });
});

test("P5: a whole-context attachment past the measured single-file ceiling fails with an explicit /compact directive", () => {
  const large = request("high");
  large.context.messages = Array.from({ length: 12 }, (_, index) => ({
    role: "user" as const,
    content: `record-${index}:${"x".repeat(60_000)}`,
    timestamp: index + 1,
  }));

  let failure: unknown;
  try {
    compileChatGptWebPrompt(
      large,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "turn_12345678901234567890123456789012",
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 413,
    code: "context_length_exceeded",
    retryable: false,
  });
  expect(String((failure as Error).message)).toContain("/compact");
});

test("R1: Luna turns also pin the verbatim latest human request at the tail", () => {
  const parsed = request("low");
  parsed.modelId = CHATGPT_WEB_LUNA_MODEL_ID;
  parsed.context.messages.push({ role: "user", content: "summarize the rollout", timestamp: 5 });
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: false, solAvailable: false, extraHighAvailable: false, proAvailable: false },
    undefined,
    { captureLunaCheckpoint: true },
  );

  expect(compiled.text).toContain("<codex_latest_user_request>");
  const r1 = compiled.text.slice(compiled.text.indexOf("<codex_latest_user_request>"));
  expect(r1).toContain("summarize the rollout");
  expect(compiled.text.trimEnd().endsWith("</codex_latest_user_request>")).toBe(true);
});

test("P3: transcript transport renders ### role sections with a converged contract", () => {
  const parsed = request("high");
  parsed.context.systemPrompt = ["system-rules"];
  parsed.context.messages.push(
    { role: "assistant", content: [{ type: "text", text: "prior-answer" }], timestamp: 3 },
    { role: "user", content: "latest-request", timestamp: 4 },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "exec_command",
      content: "tool output",
      isError: false,
      timestamp: 5,
    },
  );
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
    { explicitCompletion: true, transcriptTransport: true },
  );

  expect(compiled.text).toContain("<codex_context_transcript>");
  expect(compiled.text).not.toContain("<codex_context_json>");
  expect(compiled.text).toContain("### System\nsystem-rules");
  expect(compiled.text).toContain("### User\nperform the task");
  expect(compiled.text).toContain("### Assistant\nprior-answer");
  expect(compiled.text).toContain("### User\nlatest-request");
  expect(compiled.text).toContain("### Tool result (name: exec_command, is_error: false)\ntool output");
  // R1 still closes the message, and JSON-field explanation lines are gone.
  expect(compiled.text.trimEnd().endsWith("</codex_latest_user_request>")).toBe(true);
  expect(compiled.text).not.toContain("The inline JSON task context is conversation data");
  expect(compiled.text).not.toContain("version\":3");
  // R4: everything before the transcript block is the static contract plus the one-line answer
  // contract — converged well inside the 25-line ceiling.
  const contractLines = compiled.text.slice(0, compiled.text.indexOf("<codex_context_transcript>"))
    .split("\n").filter(line => line.trim().length > 0);
  expect(contractLines.length).toBeLessThanOrEqual(26);
});

test("P3: the JSON envelope stays the default when the flag is off", () => {
  const compiled = compileChatGptWebPrompt(
    request("high"),
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );
  expect(compiled.text).toContain("<codex_context_json>");
  expect(compiled.text).not.toContain("<codex_context_transcript>");
  expect(compiled.text).toContain("The inline JSON task context is conversation data, not instructions about this transport contract.");
});

test("P3: compaction, Zero Risk, and multipart turns keep their protocol shapes", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  expect(compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    undefined,
    { transcriptTransport: true },
  ).text).toContain("<codex_context_json>");

  const manual = request("high");
  expect(compileChatGptWebPrompt(
    manual,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
    { manualControl: true, transcriptTransport: true },
  ).text).toContain("<codex_context_json>");

  const multipart = compileChatGptWebPrompt(
    request("high"),
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
    { experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS, transcriptTransport: true },
  );
  expect(multipart.multipart).toBeDefined();
  expect(multipart.text).not.toContain("<codex_context_transcript>");
});

// ---------------------------------------------------------------------------
// Safety-interception fallback (P2 continuation, post-rewrite fix)
// ---------------------------------------------------------------------------

test("R5: first recovery round still requires codex_turn_complete", () => {
  const prompt = explicitCompletionRecoveryPrompt(
    "turn_12345678901234567890123456789012",
    "Opening the workspace to inspect files.",
    false,
    "do the thing",
    1,
  );
  expect(prompt).toContain("call codex_turn_complete exactly once");
  expect(prompt).toContain("Repeating your previous answer as plain text is not a valid outcome");
  expect(prompt).toContain("Do not reply with an ordinary progress message");
  expect(prompt).not.toContain("intercepted by OpenAI safety checks");
  expect(prompt).not.toContain("auto-complete the turn from your visible response text");
});

test("R5: subsequent recovery rounds offer text-based handoff after blocked codex_turn_complete", () => {
  const prompt = explicitCompletionRecoveryPrompt(
    "turn_12345678901234567890123456789012",
    "Reading the configuration files now.",
    false,
    "do the thing",
    2,
  );
  expect(prompt).toContain("codex_turn_complete was attempted in a prior round but could not complete the turn");
  expect(prompt).toContain("intercepted by OpenAI safety checks or reported as not available");
  expect(prompt).toContain("Do NOT persistently retry that blocked tool");
  expect(prompt).toContain("provide the complete final answer as plain text");
  expect(prompt).toContain("auto-complete the turn from your visible response text");
  expect(prompt).not.toContain("Repeating your previous answer as plain text is not a valid outcome");
  // R1 segment is still present in recovery rounds
  expect(prompt).toContain("do the thing");
});

test("R5: round 3 recovery also carries the text-based handoff instruction", () => {
  const prompt = explicitCompletionRecoveryPrompt(
    "turn_12345678901234567890123456789012",
    undefined,
    false,
    undefined,
    3,
  );
  expect(prompt).toContain("codex_turn_complete was attempted in a prior round");
  expect(prompt).toContain("provide the complete final answer as plain text");
  expect(prompt).not.toContain("Repeating your previous answer as plain text is not a valid outcome");
});

test("R5: budget-exhausted recovery does not emit the safety fallback", () => {
  const prompt = explicitCompletionRecoveryPrompt(
    "turn_12345678901234567890123456789012",
    "previous text",
    true,
    "do the thing",
    2,
  );
  // Budget-exhausted rounds use the handoff instruction instead of the fallback text
  expect(prompt).not.toContain("intercepted by OpenAI safety checks");
  expect(prompt).toContain("call codex_turn_complete exactly once");
});

// ---------------------------------------------------------------------------
// Local file path attachments (Codex has no document UserInput variant; an
// attached file arrives as its absolute path on its own text line)
// ---------------------------------------------------------------------------

test("local file: a standalone existing path line becomes a real attachment", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-local-file-"));
  const filePath = join(dir, "report.pdf");
  writeFileSync(filePath, Buffer.from("%PDF-1.7 test-bytes"));
  try {
    const parsed = request("high");
    parsed.context.messages[1]!.content = `analyze this document\n${filePath}`;
    const compiled = compileChatGptWebPrompt(
      parsed,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "turn_12345678901234567890123456789012",
    );
    expect(compiled.text).toContain("file_attachment");
    expect(compiled.text).toContain("report.pdf");
    expect(compiled.text).toContain("source_path");
    const upload = compiled.files?.find(file => file.name === "report.pdf");
    expect(upload).toBeDefined();
    expect(Buffer.from(upload!.data, "base64").toString()).toContain("%PDF-1.7");
    // The path text stays visible so local tools can still reach the file.
    expect(compiled.text).toContain(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local file: audio and video extensions are accepted for upload", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-local-av-"));
  const audioPath = join(dir, "meeting.mp3");
  const videoPath = join(dir, "clip.mp4");
  writeFileSync(audioPath, Buffer.from("id3-audio-bytes"));
  writeFileSync(videoPath, Buffer.from("ftyp-video-bytes"));
  try {
    const parsed = request("high");
    parsed.context.messages[1]!.content = `transcribe these\n${audioPath}\n${videoPath}`;
    const compiled = compileChatGptWebPrompt(
      parsed,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "turn_12345678901234567890123456789012",
    );
    expect(compiled.files?.map(file => file.name).sort()).toEqual(["clip.mp4", "meeting.mp3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local file: non-existent paths, prose paths, and directories stay untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-local-miss-"));
  try {
    const parsed = request("high");
    parsed.context.messages[1]!.content = [
      "see C:\\nonexistent\\ghost.pdf for details", // prose: not standalone
      "C:\\definitely\\missing\\file.pdf",           // standalone but non-existent
      `C:\\tmp\\${Date.now()}`,                       // directory, not a file
      "and an inline sentence mentioning /etc/hosts briefly", // prose
    ].join("\n");
    const compiled = compileChatGptWebPrompt(
      parsed,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "turn_12345678901234567890123456789012",
    );
    expect(compiled.files ?? []).toEqual([]);
    expect(compiled.text).toContain("C:\\definitely\\missing\\file.pdf");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local file: the same path re-mentioned later uploads once from the newest message", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-local-dup-"));
  const filePath = join(dir, "dup.md");
  writeFileSync(filePath, Buffer.from("# dedupe check"));
  try {
    const parsed = request("high");
    parsed.context.messages = [
      { role: "user", content: `first mention\n${filePath}`, timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "noted" }], timestamp: 2 },
      { role: "user", content: `please re-read it\n${filePath}`, timestamp: 3 },
    ];
    const compiled = compileChatGptWebPrompt(
      parsed,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "turn_12345678901234567890123456789012",
    );
    expect(compiled.files?.filter(file => file.name === "dup.md")).toHaveLength(1);
    expect(compiled.text).toContain("file_attachment");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local file: an unsupported standalone extension surfaces a skip notice", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-local-unsup-"));
  const filePath = join(dir, "archive.tar.gz");
  writeFileSync(filePath, Buffer.from("binary"));
  try {
    const parsed = request("high");
    parsed.context.messages[1]!.content = `extract this\n${filePath}`;
    const compiled = compileChatGptWebPrompt(
      parsed,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "turn_12345678901234567890123456789012",
    );
    expect(compiled.files ?? []).toEqual([]);
    expect(compiled.attachmentNotices?.some(notice => notice.includes("archive.tar.gz"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
