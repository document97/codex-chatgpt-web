import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

function workerWithFailingComposer(): Record<string, any> {
  const worker: Record<string, any> = Object.create(ChatGptBrowserWorker.prototype);
  worker.activeComposer = async () => {
    throw new Error("Visible ChatGPT composer count was 0");
  };
  return worker;
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
