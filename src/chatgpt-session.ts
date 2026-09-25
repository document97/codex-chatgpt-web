import type { Locator, Page } from "playwright-core";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  // The current composer is a ProseMirror editor that ships with no prompt-textarea marker and no
  // Lexical marker; the launcher host already accepts this shape for its own session probe, so the
  // helper must accept it too or every operation reports the session surface as unavailable.
  '[contenteditable="true"][role="textbox"].ProseMirror',
  '[contenteditable="true"][role="textbox"]',
].join(", ");
export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  // The current shell exposes exactly one menu button inside the composer form: the model and
  // effort picker. Anchor it to that form so unrelated page menus are never adopted.
  'form[data-chatgpt-composer] button[aria-haspopup="menu"]',
].join(", ");
// Same control, addressed relative to the composer form the caller already holds.
export const CHATGPT_EFFORT_CONTROL_IN_COMPOSER_SELECTOR = [
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  'button[aria-haspopup="menu"]',
].join(", ");
// The current shell renders the send control as the composer form's only submit button.
export const CHATGPT_SEND_BUTTON_SELECTOR = [
  'button[type="submit"]',
  '[data-testid="send-button"]',
].join(", ");
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
].join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
/**
 * Suggestion and command rows across the shells this adapter supports. The current composer renders
 * them as plain list-navigation buttons with no role and no tabindex; the display name lives in one
 * child element and its description is a sibling, so the row's own text is "<name><description>".
 * The CSS-module `__menu-item` shape is the legacy contract.
 */
export const CHATGPT_MENU_ROW_SELECTOR = [
  'button[data-list-navigation-item="true"]',
  '.__menu-item[tabindex="0"]',
].join(", ");
/**
 * A selected connector is an app mention node in the current ProseMirror composer, carrying the
 * display name in `app-mention-display-name`; legacy builds used a Lexical plugin pill whose
 * `data-keyword` held the same name. Reading either keeps connector proofs comparable.
 */
export const CHATGPT_SELECTED_CONNECTOR_SELECTOR = [
  "[app-mention-name]",
  '[data-id^="plugin:"][data-keyword]',
].join(", ");
export const CHATGPT_SELECTED_CONNECTOR_NAME_ATTRIBUTE = "app-mention-display-name";
/** The current menu marks its keyboard owner with aria-current instead of data-highlighted. */
export const CHATGPT_MENU_ROW_HIGHLIGHT_ATTRIBUTES = ["data-highlighted", "aria-current"];
// The current shell keeps the same ARIA contract but renames the container markers: the visible
// range wrapper is [data-model-picker-power-slider] and its keyboard owner is [data-reasoning-slider].
export const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR = [
  "[data-model-reasoning-effort-slider]",
  "[data-model-picker-power-slider]",
  "[data-reasoning-slider]",
].join(", ");
export const CHATGPT_EFFORT_SLIDER_SELECTOR = [
  '[data-model-reasoning-effort-slider] [role="slider"]',
  '[data-model-picker-power-slider] [role="slider"]',
  '[data-reasoning-slider] [role="slider"]',
].join(", ");
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 5;
// The current shell drops the stop test id and labels the streaming control in the UI language.
export const CHATGPT_STOP_BUTTON_SELECTOR = [
  '[data-testid="stop-button"]',
  'button[aria-label="停止"]',
  'button[aria-label="Stop"]',
].join(", ");
// The current shell labels the assistant turn's action bar "复制"/"Copy". Its user turn carries a
// separate "复制消息"/"Copy message" action ahead of the answer, which is not completion evidence.
export const CHATGPT_COMPLETION_ACTION_SELECTOR = [
  'button[data-testid="copy-turn-action-button"]',
  'button[aria-label="复制"]',
  'button[aria-label="Copy"]',
].join(", ");
export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
  // The current shell tags each message wrapper instead of the turn and renders answers as
  // [data-markdown-text-style] instead of .markdown.
  "[data-chatgpt-selection-message-id]:has([data-markdown-text-style])",
].join(", ");
export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
  "[data-user-message-bubble]",
].join(", ");
// The current shell drops data-turn-id* and keeps one UUID per turn on [data-turn-key].
export const CHATGPT_TURN_CONTAINER_SELECTOR = "[data-turn-id-container], [data-turn-key]";
// Identity stamped on the turn owner itself: legacy containers, current turn containers.
export const CHATGPT_TURN_CONTAINER_IDENTITY_ATTRIBUTES = [
  "data-turn-id-container",
  "data-turn-key",
] as const;
// Identity stamped on a message. The current shell stamps none, so a message belongs to the
// nearest container instead.
export const CHATGPT_TURN_MESSAGE_IDENTITY_ATTRIBUTES = ["data-turn-id"] as const;
// How a known turn identity is located again once the submission was accepted.
export const CHATGPT_TURN_IDENTITY_ATTRIBUTES = ["data-turn-id", "data-turn-key"] as const;

/**
 * Locate the element that owns one accepted turn. The legacy shell stamps the turn id on the
 * assistant message; the current shell stamps it on the turn container, whose action bar sits
 * beside the message rather than inside it. Answer text is still read from the Markdown roots
 * inside this element, so the user's own message never joins the answer.
 */
export function chatGptResponseTurnSelector(identity: string): string {
  return CHATGPT_TURN_IDENTITY_ATTRIBUTES
    .map(attribute => `[${attribute}=${JSON.stringify(identity)}]`)
    .join(", ");
}

export interface ChatGptEffortSliderState {
  min: number;
  max: number;
  value: number;
}

export interface ChatGptEffortActivation {
  method: "already-open" | "click" | "pointerdown";
  menu: Locator;
  sliderContainer: Locator;
  slider: Locator;
}

export function chatGptEffortSlider(page: Page): { sliderContainer: Locator; slider: Locator } {
  const sliderContainer = page.locator(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR).filter({ visible: true }).last();
  // The current picker keeps ARIA values on a zero-width, aria-hidden semantic input.
  // Its visible container proves the active surface; the input proves the effort range.
  return { sliderContainer, slider: sliderContainer.locator('[role="slider"]') };
}

function effortMenuSelectorForId(menuId: string): string {
  return `[id=${JSON.stringify(menuId)}]`;
}

export async function chatGptEffortMenuForControl(page: Page, control: Locator): Promise<Locator> {
  const menuId = await control.getAttribute("aria-controls").catch(() => null);
  if (menuId) return page.locator(effortMenuSelectorForId(menuId));
  return page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true }).last();
}

async function visibleEffortSurface(
  page: Page,
  control: Locator,
): Promise<Omit<ChatGptEffortActivation, "method"> | undefined> {
  // The exit animation keeps a closed menu's slider visible after Escape. Read the
  // owner state first: selecting that outgoing range races its removal from the DOM.
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  if (expanded === "false" || state === "closed") return undefined;
  const menu = await chatGptEffortMenuForControl(page, control);
  const surface = chatGptEffortSlider(page);
  if (await menu.isVisible().catch(() => false) || await surface.sliderContainer.isVisible().catch(() => false)) {
    return { menu, ...surface };
  }
  return undefined;
}

async function waitForEffortSurface(
  page: Page,
  control: Locator,
  timeoutMs: number,
): Promise<Omit<ChatGptEffortActivation, "method"> | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const surface = await visibleEffortSurface(page, control);
    if (surface) return surface;
    if (Date.now() >= deadline) return undefined;
    await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
  } while (true);
}

async function clearGhostEffortState(page: Page, control: Locator): Promise<void> {
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  if (expanded === "true" || state === "open") {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

export async function activateChatGptEffortMenu(
  page: Page,
  control: Locator,
  options: { settleMs?: number } = {},
): Promise<ChatGptEffortActivation> {
  const openSurface = await visibleEffortSurface(page, control);
  if (openSurface) return { method: "already-open", ...openSurface };

  const settleMs = options.settleMs ?? 3_000;
  await clearGhostEffortState(page, control);
  await control.click({ force: true, timeout: Math.max(1, settleMs) });
  const clickedSurface = await waitForEffortSurface(page, control, settleMs);
  if (clickedSurface) return { method: "click", ...clickedSurface };

  await clearGhostEffortState(page, control);
  await control.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    pointerType: "mouse",
    isPrimary: true,
  });
  const pointerSurface = await waitForEffortSurface(page, control, settleMs);
  if (pointerSurface) return { method: "pointerdown", ...pointerSurface };
  throw new Error(
    "ChatGPT effort control did not expose its owned menu or structural slider after click and primary pointerdown",
  );
}

function safeIntegerAttribute(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseChatGptEffortSliderState(
  rawMin: string | null,
  rawMax: string | null,
  rawValue: string | null,
): ChatGptEffortSliderState | undefined {
  const min = safeIntegerAttribute(rawMin);
  const max = safeIntegerAttribute(rawMax);
  const value = safeIntegerAttribute(rawValue);
  if (min === undefined || max === undefined || value === undefined) return undefined;
  const optionCount = max - min + 1;
  if (optionCount < 1 || optionCount > CHATGPT_EFFORT_SLIDER_MAX_OPTIONS) return undefined;
  if (value < min || value > max) return undefined;
  return { min, max, value };
}

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

export async function assertAuthenticatedChatGptPage(page: Page): Promise<void> {
  const composer = page.locator(
    CHATGPT_COMPOSER_SELECTOR,
  );
  if (!await anyVisible(composer)) {
    throw new Error("ChatGPT authentication could not be verified: no visible composer is present");
  }
}

export async function assertTemporaryChatPage(page: Page): Promise<void> {
  const url = new URL(page.url());
  const expected = new URL(CHATGPT_TEMPORARY_CHAT_URL);
  // The current shell keeps ?temporary-chat=true but moves the document to /c/<conversation-id>
  // as soon as the isolated chat holds its first turn, so the bare root path is no longer the
  // only shape that proves this surface.
  const onIsolatedPath = url.pathname === expected.pathname || /^\/c\/[^/]+$/.test(url.pathname);
  if (url.origin !== expected.origin || !onIsolatedPath || url.searchParams.get("temporary-chat") !== "true") {
    throw new Error(`ChatGPT left the isolated Temporary Chat surface (${page.url()})`);
  }
}

export async function detectChatGptAccountCapabilities(
  page: Page,
  options: { selectorTimeoutMs?: number; stableAbsenceMs?: number } = {},
): Promise<ChatGptWebAccountCapabilities & { extraHighAvailable: boolean }> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const composer = composers.last();
  const composerForm = composer.locator("xpath=ancestor::form[1]");
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_IN_COMPOSER_SELECTOR).last();
  const deadline = Date.now() + (options.selectorTimeoutMs ?? 30_000);
  const stableAbsenceMs = options.stableAbsenceMs ?? 3_000;
  let absenceSince: number | undefined;
  let presenceObservations = 0;
  while (true) {
    const effortVisible = await effortButton.isVisible().catch(() => false);
    if (effortVisible) {
      presenceObservations += 1;
      absenceSince = undefined;
      if (presenceObservations >= 2) break;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
      continue;
    }
    presenceObservations = 0;
    const composerReady = await composers.count().then(count => count === 1).catch(() => false);
    const formReady = await composerForm.count().then(count => count === 1).catch(() => false);
    const documentReady = await page.evaluate(() => document.readyState === "complete").catch(() => false);
    if (composerReady && formReady && documentReady) {
      absenceSince ??= Date.now();
      if (Date.now() - absenceSince >= stableAbsenceMs) {
        return { solAvailable: false, extraHighAvailable: false, proAvailable: false };
      }
    } else {
      absenceSince = undefined;
    }
    if (Date.now() >= deadline) {
      throw new Error("ChatGPT account capability probe did not reach a stable composer state");
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  const menu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last();
  const menuVisible = await menu.isVisible().catch(() => false);
  const menuExpanded = await effortButton.getAttribute("aria-expanded").catch(() => null);
  if (!menuVisible && menuExpanded !== "true") await effortButton.press("Enter");
  try {
    const { sliderContainer, slider } = chatGptEffortSlider(page);
    const timeout = options.selectorTimeoutMs ?? 70_000;
    // Model radio rows can hydrate before the effort control. They carry no evidence
    // of the account's reasoning range, so an absent slider must fail, not cache false.
    await sliderContainer.waitFor({ state: "visible", timeout });
    await slider.waitFor({ state: "attached", timeout });
    const state = parseChatGptEffortSliderState(
      await slider.getAttribute("aria-valuemin"),
      await slider.getAttribute("aria-valuemax"),
      await slider.getAttribute("aria-valuenow"),
    );
    if (!state) {
      throw new Error(
        "ChatGPT model controls are unavailable. Reload ChatGPT and run Repair again.",
        { cause: new Error("ChatGPT effort slider exposed an invalid ARIA range") },
      );
    }
    return { solAvailable: true, extraHighAvailable: state.max - state.min + 1 >= 4, proAvailable: state.max - state.min + 1 >= 5 };
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
