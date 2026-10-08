import { ChatBedrockConverse } from "@langchain/aws";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createOptionalBedrockPromptCachingMiddleware } from "../../src/agent/bedrock-prompt-caching-middleware.ts";

type CachingRequest = {
  model: unknown;
  modelSettings?: Record<string, unknown>;
};

type CachingMiddleware = {
  wrapModelCall?: (
    request: CachingRequest,
    handler: (next: CachingRequest) => Promise<CachingRequest>,
  ) => Promise<CachingRequest>;
};

const originalTtl = process.env.OPENWIKI_BEDROCK_CACHE_TTL;

beforeEach(() => {
  delete process.env.OPENWIKI_BEDROCK_CACHE_TTL;
});

afterEach(() => {
  if (originalTtl === undefined) {
    delete process.env.OPENWIKI_BEDROCK_CACHE_TTL;
  } else {
    process.env.OPENWIKI_BEDROCK_CACHE_TTL = originalTtl;
  }
});

function createBedrockModel(): BaseChatModel {
  return new ChatBedrockConverse({
    model: "us.anthropic.claude-sonnet-5",
    region: "us-east-1",
    credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" },
  });
}

function createOtherProviderModel(): BaseChatModel {
  return { getName: () => "ChatOpenAI" } as unknown as BaseChatModel;
}

async function wrap(
  model: BaseChatModel,
  request: CachingRequest = { model },
): Promise<CachingRequest> {
  const middleware = createOptionalBedrockPromptCachingMiddleware(model) as
    CachingMiddleware | undefined;

  if (!middleware?.wrapModelCall) {
    throw new Error("Expected the Bedrock prompt-caching model-call wrapper.");
  }

  return middleware.wrapModelCall(request, (next) => Promise.resolve(next));
}

describe("createOptionalBedrockPromptCachingMiddleware", () => {
  test("requests a 5m ephemeral cache point for Bedrock Converse models", async () => {
    const forwarded = await wrap(createBedrockModel());

    expect(forwarded.modelSettings).toEqual({
      cache_control: { type: "ephemeral", ttl: "5m" },
    });
  });

  test("honors the configured TTL", async () => {
    process.env.OPENWIKI_BEDROCK_CACHE_TTL = "1h";

    const forwarded = await wrap(createBedrockModel());

    expect(forwarded.modelSettings).toEqual({
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  });

  test("identifies the model by name rather than by class identity", async () => {
    const duplicatedPackageModel = {
      getName: () => "ChatBedrockConverse",
    } as unknown as BaseChatModel;

    const forwarded = await wrap(duplicatedPackageModel);

    expect(forwarded.modelSettings).toEqual({
      cache_control: { type: "ephemeral", ttl: "5m" },
    });
  });

  test("preserves model settings contributed by other middleware", async () => {
    const model = createBedrockModel();

    const forwarded = await wrap(model, {
      model,
      modelSettings: { strict: true },
    });

    expect(forwarded.modelSettings).toEqual({
      strict: true,
      cache_control: { type: "ephemeral", ttl: "5m" },
    });
  });

  test("forwards the request unchanged when the model is swapped for another provider's", async () => {
    const request = { model: createOtherProviderModel() };

    const forwarded = await wrap(createBedrockModel(), request);

    expect(forwarded).toBe(request);
    expect(forwarded.modelSettings).toBeUndefined();
  });

  test("installs nothing when caching is turned off", () => {
    process.env.OPENWIKI_BEDROCK_CACHE_TTL = "off";

    expect(
      createOptionalBedrockPromptCachingMiddleware(createBedrockModel()),
    ).toBeUndefined();
  });

  test("installs nothing for a model from another provider", () => {
    expect(
      createOptionalBedrockPromptCachingMiddleware(createOtherProviderModel()),
    ).toBeUndefined();
  });

  test("rejects an invalid TTL before a Bedrock agent runs", () => {
    process.env.OPENWIKI_BEDROCK_CACHE_TTL = "10m";

    expect(() =>
      createOptionalBedrockPromptCachingMiddleware(createBedrockModel()),
    ).toThrow(/OPENWIKI_BEDROCK_CACHE_TTL/u);
  });

  test("never reads the Bedrock TTL for another provider's model", () => {
    process.env.OPENWIKI_BEDROCK_CACHE_TTL = "10m";

    expect(
      createOptionalBedrockPromptCachingMiddleware(createOtherProviderModel()),
    ).toBeUndefined();
  });
});
