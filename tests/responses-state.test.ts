import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  expandPreviousResponseInput,
  previousResponseReplayPrefixLength,
  rememberResponseState,
} from "../src/responses/state";
import { replayCodexRolloutResponseItems } from "../src/adapters/chatgpt-web/codex-rollout-environment";

const THREAD_ID = "12345678-1234-4123-8123-123456789012";
const TURN_ID = "22345678-1234-4123-8123-123456789012";

let homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
});

function isolate(): { appHome: string; codexHome: string } {
  const root = mkdtempSync(join(tmpdir(), "cgw-responses-state-"));
  homes.push(root);
  const appHome = join(root, "app");
  const codexHome = join(root, "codex");
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  process.env.CODEX_HOME = codexHome;
  return { appHome, codexHome };
}

function wireBody(input: unknown[], threadId = THREAD_ID, previousId?: string) {
  return {
    model: "gpt-5.6",
    input,
    ...(previousId ? { previous_response_id: previousId } : {}),
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: threadId, turn_id: TURN_ID }),
    },
  };
}

function rolloutJsonl(codexHome: string, threadId: string, items: unknown[]): void {
  const dir = join(codexHome, "sessions", "2026", "09", "22");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-09-22T08-00-00-${threadId}.jsonl`),
    items.map(item => `${JSON.stringify(item)}\n`).join(""),
    "utf8",
  );
}

const responseItem = (payload: unknown) => ({ type: "response_item", payload });

describe("responses-state chain storage (P4)", () => {
  test("a chained turn expands through the parent chain instead of full copies", () => {
    isolate();
    const first = wireBody([{ role: "user", content: "build this" }], THREAD_ID);
    rememberResponseState(first, {
      id: "resp_1",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "working" }] }],
      status: "completed",
    }, { force: true });

    const second = wireBody([{ role: "user", content: "next step" }], THREAD_ID, "resp_1");
    const expanded = expandPreviousResponseInput(second) as { input: unknown[] };
    expect(expanded.input).toEqual([
      { role: "user", content: "build this" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "working" }] },
      { role: "user", content: "next step" },
    ]);
    expect(previousResponseReplayPrefixLength(expanded)).toBe(2);

    // The third turn resolves two links deep through the same public entry point.
    rememberResponseState(second, {
      id: "resp_2",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      status: "completed",
    }, { force: true });
    const third = wireBody([{ role: "user", content: "one more" }], THREAD_ID, "resp_2");
    const deep = expandPreviousResponseInput(third) as { input: unknown[] };
    expect(deep.input).toEqual([
      { role: "user", content: "build this" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "working" }] },
      { role: "user", content: "next step" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      { role: "user", content: "one more" },
    ]);
    expect(previousResponseReplayPrefixLength(deep)).toBe(4);
  });
});

describe("responses-state rollout replay fallback (P4/R3)", () => {
  test("a cache miss rebuilds the prefix from the thread rollout when the delta tails it", () => {
    const { codexHome } = isolate();
    const history = [
      { role: "user", content: "build this" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "working" }] },
      { role: "user", content: "next step" },
    ];
    rolloutJsonl(codexHome, THREAD_ID, [...history.map(responseItem), { type: "event_msg", payload: {} }]);
    expect(replayCodexRolloutResponseItems({ codexHome, threadId: THREAD_ID })).toEqual(history);

    // The in-memory cache never saw resp_unknown, so the expansion replays the rollout prefix.
    const body = wireBody([{ role: "user", content: "next step" }], THREAD_ID, "resp_unknown");
    const expanded = expandPreviousResponseInput(body) as { input: unknown[] };
    expect(expanded.input).toEqual(history);
    expect(previousResponseReplayPrefixLength(expanded)).toBe(2);
  });

  test("the replay declines when the request delta is not the rollout tail", () => {
    const { codexHome } = isolate();
    rolloutJsonl(codexHome, THREAD_ID, [
      responseItem({ role: "user", content: "build this" }),
      responseItem({ type: "message", role: "assistant", content: "working" }),
    ]);
    const body = wireBody([{ role: "user", content: "something else entirely" }], THREAD_ID, "resp_unknown");
    expect(expandPreviousResponseInput(body)).toBe(body);
    expect(previousResponseReplayPrefixLength(body)).toBe(0);
  });

  test("an absent rollout declines the replay and returns the body untouched", () => {
    const { codexHome } = isolate();
    mkdirSync(codexHome, { recursive: true });
    const body = wireBody([{ role: "user", content: "next" }], THREAD_ID, "resp_unknown");
    expect(replayCodexRolloutResponseItems({ codexHome, threadId: THREAD_ID })).toBeUndefined();
    expect(expandPreviousResponseInput(body)).toBe(body);
  });
});
