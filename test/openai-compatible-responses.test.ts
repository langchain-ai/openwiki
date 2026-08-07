import { beforeEach, describe, expect, test, vi } from "vitest";

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

vi.mock("../src/connectors/write-connector-skill.js", () => ({
  ensureWriteConnectorSkill: vi.fn(() => undefined),
}));

describe("openai-compatible responses API opt-in", () => {
  beforeEach(() => {
    chatOpenAiCalls.length = 0;
    delete process.env.OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API;
  });

  test("keeps OpenAI-compatible providers on chat completions by default", async () => {
    const { createModel } = await import("../src/agent/index.ts");

    createModel("openai-compatible", "local-model", 3);

    expect(chatOpenAiCalls[0]).toEqual(
      expect.objectContaining({
        model: "local-model",
        useResponsesApi: false,
      }),
    );
  });

  test("enables Responses API for OpenAI-compatible providers when opted in", async () => {
    process.env.OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API = "true";
    const { createModel } = await import("../src/agent/index.ts");

    createModel("openai-compatible", "local-model", 3);

    expect(chatOpenAiCalls[0]).toEqual(
      expect.objectContaining({
        model: "local-model",
        useResponsesApi: true,
      }),
    );
  });
});
