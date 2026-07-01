import { describe, expect, it } from "vitest";
import { buildChatOpenAIFields, shouldUseOpenAiResponsesApi } from "./model.js";

describe("shouldUseOpenAiResponsesApi", () => {
  it("enables responses API for gpt-5 reasoning models", () => {
    expect(shouldUseOpenAiResponsesApi("gpt-5.5")).toBe(true);
    expect(shouldUseOpenAiResponsesApi("gpt-5.4-mini")).toBe(true);
    expect(shouldUseOpenAiResponsesApi("gpt-5.3-codex")).toBe(true);
  });

  it("does not enable responses API for gpt-5-chat models", () => {
    expect(shouldUseOpenAiResponsesApi("gpt-5-chat-latest")).toBe(false);
  });

  it("enables responses API for o-series models", () => {
    expect(shouldUseOpenAiResponsesApi("o3")).toBe(true);
    expect(shouldUseOpenAiResponsesApi("o4-mini")).toBe(true);
  });

  it("does not enable responses API for gpt-4 models", () => {
    expect(shouldUseOpenAiResponsesApi("gpt-4o-mini")).toBe(false);
  });
});

describe("buildChatOpenAIFields", () => {
  it("sets useResponsesApi for OpenAI gpt-5 models", () => {
    expect(
      buildChatOpenAIFields("openai", "gpt-5.5", "test-key"),
    ).toMatchObject({
      apiKey: "test-key",
      model: "gpt-5.5",
      useResponsesApi: true,
    });
  });

  it("does not set useResponsesApi for non-reasoning OpenAI models", () => {
    const fields = buildChatOpenAIFields("openai", "gpt-4o-mini", "test-key");

    expect(fields.model).toBe("gpt-4o-mini");
    expect(fields).not.toHaveProperty("useResponsesApi");
  });

  it("does not set useResponsesApi for fireworks even with gpt-5 model id", () => {
    const fields = buildChatOpenAIFields("fireworks", "gpt-5.5", "test-key");

    expect(fields.model).toBe("gpt-5.5");
    expect(fields).not.toHaveProperty("useResponsesApi");
  });
});
