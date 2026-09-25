import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CHATGPT_MENU_ROW_HIGHLIGHT_ATTRIBUTES,
  CHATGPT_MENU_ROW_SELECTOR,
  CHATGPT_SELECTED_CONNECTOR_NAME_ATTRIBUTE,
  CHATGPT_SELECTED_CONNECTOR_SELECTOR,
} from "../src/chatgpt-session";

const connectorMenuHtml = readFileSync(
  new URL("./fixtures/chatgpt-connector-menu.html", import.meta.url),
  "utf8",
);
// The pre-ProseMirror shell: a focusable CSS-module menu row plus a Lexical plugin pill.
const legacyConnectorHtml = `<!doctype html><html><body>
  <form data-chatgpt-composer>
    <div contenteditable="true" role="textbox" data-lexical-editor="true">
      <p><span data-id="plugin:codex-native2" data-keyword="Codex Native2">Codex Native2</span></p>
    </div>
  </form>
  <div class="popover" aria-busy="false">
    <div class="__menu-item" tabindex="0" data-highlighted=""><span>Codex Native2</span></div>
  </div>
</body></html>`;

function connectorDocument(html: string): Document {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  return createDocument(html);
}

function rowLabels(rows: Element[]): string[] {
  // Mirrors ChatGptBrowserWorker.connectorMentionRowTitles: a current row's own text is
  // "<name><description>", so the exact connector name is one child element's text.
  return [...new Set(rows.flatMap(row => (
    [row, ...row.querySelectorAll("*")]
      .map(node => (node.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(label => label.length > 0 && label.length <= 64)
  )))];
}

test("the current connector menu rows are found and the legacy row marker is absent", () => {
  const document = connectorDocument(connectorMenuHtml);
  const rows = Array.from(document.querySelectorAll(CHATGPT_MENU_ROW_SELECTOR));
  expect(rows).toHaveLength(2);
  expect(document.querySelectorAll('.__menu-item[tabindex="0"]')).toHaveLength(0);
  // The row's own text cannot equal the connector name, which is why exact row text never matched.
  expect(rows[0]?.textContent).toBe("Codex Native2test");
  expect(rowLabels([rows[0]!])).toContain("Codex Native2");
  expect(rowLabels(rows)).toContain("OpenAI Platform");
});

test("only the connector row is the keyboard owner and it is marked with aria-current", () => {
  const document = connectorDocument(connectorMenuHtml);
  const rows = Array.from(document.querySelectorAll(CHATGPT_MENU_ROW_SELECTOR));
  const owners = rows.filter(row => row.getAttribute("aria-current") === "true");
  expect(owners).toHaveLength(1);
  expect(owners[0]?.textContent).toBe("Codex Native2test");
  expect(CHATGPT_MENU_ROW_HIGHLIGHT_ATTRIBUTES).toEqual(["data-highlighted", "aria-current"]);
  expect(owners[0]?.getAttribute("data-highlighted")).toBeNull();
});

test("a selected connector is proven from the app mention node, not a plugin pill", () => {
  const document = connectorDocument(connectorMenuHtml);
  const selected = Array.from(document.querySelectorAll(CHATGPT_SELECTED_CONNECTOR_SELECTOR));
  expect(selected).toHaveLength(1);
  expect(selected[0]?.getAttribute(CHATGPT_SELECTED_CONNECTOR_NAME_ATTRIBUTE)).toBe("Codex Native2");
  expect(selected[0]?.getAttribute("app-mention-path")).toBe(
    "app://asdk_app_6aa3edce91288191874cee5131c4c9af",
  );
  expect(document.querySelectorAll('[data-id^="plugin:"][data-keyword]')).toHaveLength(0);
});

test("the mention node is not part of the prompt text", () => {
  const document = connectorDocument(connectorMenuHtml);
  const composer = document.querySelector(CHATGPT_SELECTED_CONNECTOR_SELECTOR);
  expect(composer).not.toBeNull();
  // attachedPromptText clones the composer and drops mention nodes before comparing the prompt.
  const clone = document.querySelector('form[data-chatgpt-composer] [role="textbox"]')!
    .cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[app-mention-name]").forEach(part => part.remove());
  expect(clone.textContent?.trim() ?? "").toBe("");
});

test("legacy menu rows and plugin pills still satisfy the same selectors", () => {
  const document = connectorDocument(legacyConnectorHtml);
  const rows = Array.from(document.querySelectorAll(CHATGPT_MENU_ROW_SELECTOR));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.getAttribute("data-highlighted")).toBe("");
  expect(rowLabels(rows)).toContain("Codex Native2");
  const selected = Array.from(document.querySelectorAll(CHATGPT_SELECTED_CONNECTOR_SELECTOR));
  expect(selected).toHaveLength(1);
  // The legacy pill carries the name in data-keyword; the mention attribute is absent.
  expect(selected[0]?.getAttribute(CHATGPT_SELECTED_CONNECTOR_NAME_ATTRIBUTE)).toBeNull();
  expect(selected[0]?.getAttribute("data-keyword")).toBe("Codex Native2");
});
