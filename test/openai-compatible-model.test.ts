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

describe("openai-compatible model creation", () => {
  beforeEach(() => {
    chatOpenAiCalls.length = 0;
  });

  test("disables provider-side thinking mode for OpenAI-compatible models", async () => {
    const { createModel } = await import("../src/agent/index.ts");

    createModel("openai-compatible", "qwen3.7-plus", 3);

    expect(chatOpenAiCalls).toHaveLength(1);
    expect(chatOpenAiCalls[0]).toEqual(
      expect.objectContaining({
        model: "qwen3.7-plus",
        modelKwargs: {
          enable_thinking: false,
        },
      }),
    );
  });
});
