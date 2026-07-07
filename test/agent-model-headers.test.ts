import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@langchain/anthropic", () => ({
  ChatAnthropic: vi.fn(function ChatAnthropic(
    model: string,
    fields: Record<string, unknown>,
  ) {
    return { fields, model };
  }),
}));

vi.mock("@langchain/langgraph-checkpoint-sqlite", () => ({
  SqliteSaver: vi.fn(),
}));

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn(function ChatOpenAI(fields: Record<string, unknown>) {
    return { fields };
  }),
}));

vi.mock("@langchain/openrouter", () => ({
  ChatOpenRouter: vi.fn(function ChatOpenRouter(
    fields: Record<string, unknown>,
  ) {
    return {
      buildHeaders() {
        return {
          Authorization: "Bearer original-openrouter-key",
          "Content-Type": "application/json",
        };
      },
      fields,
    };
  }),
}));

vi.mock("deepagents", () => ({
  createDeepAgent: vi.fn(),
  LocalShellBackend: vi.fn(),
}));

describe("createModel model headers", () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
    delete process.env.OPENAI_COMPATIBLE_BASE_URL;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENWIKI_MODEL_HEADERS;
    vi.clearAllMocks();
  });

  test("passes configured headers to ChatOpenAI clients", async () => {
    const { ChatOpenAI } = await import("@langchain/openai");
    const { createModel } = await import("../src/agent/index.ts");

    process.env.OPENAI_COMPATIBLE_API_KEY = "gateway-key";
    process.env.OPENAI_COMPATIBLE_BASE_URL = "https://gateway.example/v1";
    process.env.OPENWIKI_MODEL_HEADERS =
      '{"X-Tenant-ID":"tenant-a","x-api-key":"secret"}';

    createModel("openai-compatible", "gateway-model");

    expect(ChatOpenAI).toHaveBeenCalledWith({
      apiKey: "gateway-key",
      configuration: {
        baseURL: "https://gateway.example/v1",
        defaultHeaders: {
          "X-Tenant-ID": "tenant-a",
          "x-api-key": "secret",
        },
      },
      model: "gateway-model",
    });
  });

  test("passes configured headers to ChatAnthropic clients", async () => {
    const { ChatAnthropic } = await import("@langchain/anthropic");
    const { createModel } = await import("../src/agent/index.ts");

    process.env.ANTHROPIC_API_KEY = "anthropic-key";
    process.env.OPENWIKI_MODEL_HEADERS = '{"X-Tenant-ID":"tenant-a"}';

    createModel("anthropic", "claude-sonnet-5");

    expect(ChatAnthropic).toHaveBeenCalledWith("claude-sonnet-5", {
      apiKey: "anthropic-key",
      clientOptions: {
        defaultHeaders: {
          "X-Tenant-ID": "tenant-a",
        },
      },
    });
  });

  test("merges configured headers into ChatOpenRouter requests", async () => {
    const { createModel } = await import("../src/agent/index.ts");

    process.env.OPENROUTER_API_KEY = "openrouter-key";
    process.env.OPENWIKI_MODEL_HEADERS =
      '{"Authorization":"Bearer custom","X-Tenant-ID":"tenant-a"}';

    const model = createModel("openrouter", "z-ai/glm-5.2") as unknown as {
      buildHeaders(): Record<string, string>;
    };

    expect(model.buildHeaders()).toEqual({
      Authorization: "Bearer custom",
      "Content-Type": "application/json",
      "X-Tenant-ID": "tenant-a",
    });
  });
});
