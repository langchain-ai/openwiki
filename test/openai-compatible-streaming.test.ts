import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const chatOpenAiCalls: unknown[] = [];

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn(function ChatOpenAIMock(options: unknown) {
    chatOpenAiCalls.push(options);
    return {};
  }),
}));

vi.mock("../src/connectors/tools.js", () => ({
  createOpenWikiConnectorTools: vi.fn(() => []),
}));

describe("openai-compatible streaming transport opt-in", () => {
  beforeEach(() => {
    chatOpenAiCalls.length = 0;
    delete process.env.OPENWIKI_OPENAI_COMPATIBLE_STREAMING;
  });

  // Cleared on the way out too, so the opt-in cannot leak into later test files
  // if worker isolation is ever turned off.
  afterEach(() => {
    delete process.env.OPENWIKI_OPENAI_COMPATIBLE_STREAMING;
  });

  test("leaves the transport at the LangChain default by default", async () => {
    const { createModel } = await import("../src/agent/index.ts");

    createModel("openai-compatible", "local-model", 3);

    expect(chatOpenAiCalls[0]).not.toHaveProperty("streaming");
  });

  test("forces the streaming transport when opted in", async () => {
    process.env.OPENWIKI_OPENAI_COMPATIBLE_STREAMING = "true";
    const { createModel } = await import("../src/agent/index.ts");

    createModel("openai-compatible", "local-model", 3);

    expect(chatOpenAiCalls[0]).toEqual(
      expect.objectContaining({
        model: "local-model",
        streaming: true,
      }),
    );
  });

  test("ignores an explicit false opt-out", async () => {
    process.env.OPENWIKI_OPENAI_COMPATIBLE_STREAMING = "false";
    const { createModel } = await import("../src/agent/index.ts");

    createModel("openai-compatible", "local-model", 3);

    expect(chatOpenAiCalls[0]).not.toHaveProperty("streaming");
  });

  test("does not affect other providers sharing the ChatOpenAI branch", async () => {
    process.env.OPENWIKI_OPENAI_COMPATIBLE_STREAMING = "true";
    const { createModel } = await import("../src/agent/index.ts");

    createModel("openai", "gpt-5.5", 3);

    expect(chatOpenAiCalls[0]).not.toHaveProperty("streaming");
  });
});
