import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const bedrockConstructorArgs = vi.hoisted(
  () => [] as Array<Record<string, unknown>>,
);

vi.mock("@langchain/aws", () => ({
  ChatBedrockConverse: class {
    constructor(options: Record<string, unknown>) {
      bedrockConstructorArgs.push(options);
    }
  },
}));

const { createModel } = await import("../../src/agent/index.ts");

const ENV_KEYS = [
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "BEDROCK_AWS_ACCESS_KEY_ID",
  "BEDROCK_AWS_REGION",
  "BEDROCK_AWS_SECRET_ACCESS_KEY",
  "OPENWIKI_MAX_OUTPUT_TOKENS",
  "OPENWIKI_BEDROCK_MAX_TOKENS",
] as const;

const originalEnv = new Map(
  ENV_KEYS.map((key) => [key, process.env[key]] as const),
);

beforeEach(() => {
  bedrockConstructorArgs.length = 0;
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("createModel Bedrock credentials", () => {
  test("delegates OIDC credentials to the AWS SDK provider chain", () => {
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/openwiki";
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/path/that/must/not/be/read";
    process.env.AWS_REGION = "us-east-1";

    createModel("bedrock", "anthropic.claude-sonnet-5", 4, 8192);

    expect(bedrockConstructorArgs).toHaveLength(1);
    expect(bedrockConstructorArgs[0]).toMatchObject({
      maxRetries: 4,
      maxTokens: 8192,
      model: "anthropic.claude-sonnet-5",
      region: "us-east-1",
    });
    expect(bedrockConstructorArgs[0]).not.toHaveProperty("credentials");
  });

  test("sets the Bedrock output-token ceiling when no output token limit is configured", () => {
    process.env.AWS_REGION = "us-east-1";

    createModel("bedrock", "anthropic.claude-sonnet-5", 4);

    expect(bedrockConstructorArgs[0]).toMatchObject({
      maxTokens: 16000,
    });
    expect(bedrockConstructorArgs[0]).not.toHaveProperty("streamIdleTimeout");
  });

  test.each([0, 300000])(
    "passes streamIdleTimeout: %i to ChatBedrockConverse",
    (streamIdleTimeout) => {
      process.env.AWS_REGION = "us-east-1";

      createModel(
        "bedrock",
        "anthropic.claude-sonnet-5",
        4,
        undefined,
        streamIdleTimeout,
      );

      expect(bedrockConstructorArgs[0]).toMatchObject({
        streamIdleTimeout,
      });
    },
  );

  test("omits streamIdleTimeout when the override is undefined", () => {
    process.env.AWS_REGION = "us-east-1";

    createModel(
      "bedrock",
      "anthropic.claude-sonnet-5",
      4,
      undefined,
      undefined,
    );

    expect(bedrockConstructorArgs[0]).not.toHaveProperty("streamIdleTimeout");
  });

  test("lets LangChain preserve complete legacy credentials and session tokens", () => {
    process.env.BEDROCK_AWS_ACCESS_KEY_ID = "legacy-access";
    process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = "legacy-secret";
    process.env.BEDROCK_AWS_REGION = "us-west-2";

    createModel("bedrock", "anthropic.claude-sonnet-5", 0);

    expect(bedrockConstructorArgs[0]).toMatchObject({
      maxRetries: 0,
      region: "us-west-2",
    });
    expect(bedrockConstructorArgs[0]).not.toHaveProperty("credentials");
  });
});

describe("createModel Bedrock output-token ceiling", () => {
  test("sets maxTokens to 16000 by default", () => {
    process.env.AWS_REGION = "us-east-1";

    createModel("bedrock", "us.anthropic.claude-sonnet-5", 0);

    expect(bedrockConstructorArgs[0]).toMatchObject({ maxTokens: 16000 });
  });

  test("passes a custom ceiling from OPENWIKI_BEDROCK_MAX_TOKENS", () => {
    process.env.AWS_REGION = "us-east-1";
    process.env.OPENWIKI_BEDROCK_MAX_TOKENS = "8192";

    createModel("bedrock", "us.anthropic.claude-sonnet-5", 0);

    expect(bedrockConstructorArgs[0]).toMatchObject({ maxTokens: 8192 });
  });

  test("prefers the provider-neutral output-token ceiling", () => {
    process.env.AWS_REGION = "us-east-1";
    process.env.OPENWIKI_MAX_OUTPUT_TOKENS = "12288";
    process.env.OPENWIKI_BEDROCK_MAX_TOKENS = "8192";

    createModel("bedrock", "us.anthropic.claude-sonnet-5", 0);

    expect(bedrockConstructorArgs[0]).toMatchObject({ maxTokens: 12288 });
  });

  test("rejects an invalid OPENWIKI_BEDROCK_MAX_TOKENS value with a clear error", () => {
    process.env.AWS_REGION = "us-east-1";
    process.env.OPENWIKI_BEDROCK_MAX_TOKENS = "lots";

    expect(() =>
      createModel("bedrock", "us.anthropic.claude-sonnet-5", 0),
    ).toThrow(/OPENWIKI_BEDROCK_MAX_TOKENS/u);
  });
});
