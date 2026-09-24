import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

function workerWithFailingComposer(): Record<string, any> {
  const worker: Record<string, any> = Object.create(ChatGptBrowserWorker.prototype);
  worker.activeComposer = async () => {
    throw new Error("Visible ChatGPT composer count was 0");
  };
  return worker;
}

function stopButtonPage(visibility: boolean[]): { page: any; clicks: string[] } {
  const clicks: string[] = [];
  const locator: any = {
    last: () => locator,
    isVisible: async () => visibility.shift() ?? false,
    click: async () => { clicks.push("click"); },
    press: async () => { clicks.push("press"); },
  };
  return { page: { locator: () => locator }, clicks };
}

test("an expired ChatGPT login is reported as expired instead of a generic surface failure", async () => {
  const worker = workerWithFailingComposer();
  const page = {
    url: () => "https://chatgpt.com/auth/login",
    goto: async () => {},
  };
  const error: Error | null = await worker.prepareTemporaryChatSurface(page).then(
    () => null,
    (cause: unknown) => cause as Error,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("ChatGPT web login is expired");
  expect((error as Error).cause).toBeInstanceOf(Error);
});

test("a hydrated session without a composer is reported as an unavailable Temporary Chat surface", async () => {
  const worker = workerWithFailingComposer();
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    goto: async () => {},
  };
  const error: Error | null = await worker.prepareTemporaryChatSurface(page).then(
    () => null,
    (cause: unknown) => cause as Error,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("ChatGPT Temporary Chat surface is unavailable");
  expect((error as Error).message).toContain("temporary-chat=true");
  expect((error as Error).cause).toBeInstanceOf(Error);
});

test("an aborted turn retries the ChatGPT stop button until the generation ends", async () => {
  const worker: Record<string, any> = Object.create(ChatGptBrowserWorker.prototype);
  const { page, clicks } = stopButtonPage([true, true, false]);
  await worker.stopChatGptGeneration(page, "turn aborted", { attempts: 3, intervalMs: 1 });
  expect(clicks).toEqual(["click", "click"]);
});

test("a stop button that rejects the click falls back to keyboard activation", async () => {
  const worker: Record<string, any> = Object.create(ChatGptBrowserWorker.prototype);
  const { page, clicks } = stopButtonPage([true, false]);
  const locator = page.locator();
  locator.click = async () => { clicks.push("click-rejected"); throw new Error("button blocked"); };
  await worker.stopChatGptGeneration(page, "turn aborted", { attempts: 2, intervalMs: 1 });
  expect(clicks).toEqual(["click-rejected", "press"]);
});

test("a stop button that never disappears is reported instead of silently swallowed", async () => {
  const worker: Record<string, any> = Object.create(ChatGptBrowserWorker.prototype);
  const { page, clicks } = stopButtonPage([true, true, true]);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    await worker.stopChatGptGeneration(page, "turn aborted", { attempts: 2, intervalMs: 1 });
  } finally {
    console.warn = originalWarn;
  }
  expect(clicks).toEqual(["click", "click"]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("stop button stayed visible");
});
