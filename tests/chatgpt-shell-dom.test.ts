import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_EFFORT_CONTROL_IN_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
  CHATGPT_SEND_BUTTON_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  assertTemporaryChatPage,
  parseChatGptEffortSliderState,
} from "../src/chatgpt-session";

const shellHtml = readFileSync(new URL("./fixtures/chatgpt-prosemirror-shell.html", import.meta.url), "utf8");
const legacyHtml = readFileSync(new URL("./fixtures/chatgpt-dil-smoke.html", import.meta.url), "utf8");

function shellDocument(html: string): Document {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  return createDocument(html);
}

function matches(document: Document, selector: string): string[] {
  return Array.from(document.querySelectorAll(selector))
    .map(element => element.id || element.getAttribute("class") || element.tagName);
}

function insideComposerForm(document: Document, selector: string): string[] {
  const form = document.querySelector("form[data-chatgpt-composer]");
  if (!form) throw new Error("composer form missing from fixture");
  return Array.from(form.querySelectorAll(selector))
    .map(element => element.id || element.getAttribute("aria-label") || element.tagName);
}

test("the current shell's composer is found by the composer selector and not by the legacy markers", () => {
  const document = shellDocument(shellHtml);
  expect(matches(document, CHATGPT_COMPOSER_SELECTOR)).toHaveLength(1);
  expect(matches(document, '[data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"]'))
    .toHaveLength(0);
  const composer = document.querySelector(CHATGPT_COMPOSER_SELECTOR);
  expect(composer?.className).toContain("ProseMirror");
  expect(composer?.getAttribute("role")).toBe("textbox");
});

test("the model picker and send control are addressed inside the composer form only", () => {
  const document = shellDocument(shellHtml);
  // The decoy sidebar menu button must never be adopted as the model picker.
  expect(matches(document, CHATGPT_EFFORT_CONTROL_SELECTOR)).toEqual(["composer-model-picker"]);
  expect(insideComposerForm(document, CHATGPT_EFFORT_CONTROL_IN_COMPOSER_SELECTOR))
    .toEqual(["composer-model-picker"]);
  expect(insideComposerForm(document, CHATGPT_SEND_BUTTON_SELECTOR)).toEqual(["Send"]);
  expect(matches(document, CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR)).toEqual(["picker", "DIV"]);
  const slider = document.querySelector(CHATGPT_EFFORT_SLIDER_SELECTOR);
  expect(slider?.getAttribute("role")).toBe("slider");
  expect(parseChatGptEffortSliderState(
    slider?.getAttribute("aria-valuemin") ?? null,
    slider?.getAttribute("aria-valuemax") ?? null,
    slider?.getAttribute("aria-valuenow") ?? null,
  )).toEqual({ min: 0, max: 2, value: 1 });
});

test("turn, completion and streaming controls are found on the current shell", () => {
  const document = shellDocument(shellHtml);
  const assistants = Array.from(document.querySelectorAll(CHATGPT_ASSISTANT_TURN_SELECTOR));
  expect(assistants).toHaveLength(1);
  expect(assistants[0].textContent).toContain("CODEX WEB GPT READY");
  expect(matches(document, CHATGPT_USER_TURN_SELECTOR)).toHaveLength(1);
  expect(matches(document, CHATGPT_COMPLETION_ACTION_SELECTOR)).toHaveLength(1);
  expect(matches(document, CHATGPT_STOP_BUTTON_SELECTOR)).toHaveLength(1);
  expect(matches(document, '[data-testid="conversation-turn-"], [data-message-author-role]')).toHaveLength(0);
});

test("the legacy shell still matches the legacy markers", () => {
  const document = shellDocument(legacyHtml);
  expect(matches(document, CHATGPT_COMPLETION_ACTION_SELECTOR)).toHaveLength(1);
  expect(matches(document, CHATGPT_ASSISTANT_TURN_SELECTOR)).toHaveLength(1);
});

test("an isolated conversation path still proves the Temporary Chat surface", async () => {
  const page = { url: () => "https://chatgpt.com/c/6ab63207-8374-83ee-802b-e0964e37396a?temporary-chat=true" } as unknown as Page;
  await expect(assertTemporaryChatPage(page)).resolves.toBeUndefined();
  const signedOut = { url: () => "https://chatgpt.com/c/6ab63207-8374-83ee-802b-e0964e37396a" } as unknown as Page;
  await expect(assertTemporaryChatPage(signedOut)).rejects.toThrow("left the isolated Temporary Chat surface");
  const shared = { url: () => "https://chatgpt.com/c/6ab63207-8374-83ee-802b-e0964e37396a?model=auto" } as unknown as Page;
  await expect(assertTemporaryChatPage(shared)).rejects.toThrow("left the isolated Temporary Chat surface");
});
