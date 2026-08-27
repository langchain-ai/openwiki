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

  test("preserves the provider default for models without a known ceiling", () => {
    process.env.AWS_REGION = "us-east-1";

    createModel("bedrock", "amazon.nova-pro-v1:0", 4);

    expect(bedrockConstructorArgs[0]).not.toHaveProperty("maxTokens");
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
  beforeEach(() => {
    process.env.AWS_REGION = "us-east-1";
  });

  // The Converse API applies its own 4096-token default when no
  // inferenceConfig is sent, which truncates long pages mid-write_file.
  test.each([
    ["bare foundation-model ID", "anthropic.claude-sonnet-5-20260101-v1:0"],
    ["cross-region inference profile", "us.anthropic.claude-sonnet-5"],
    ["EU inference profile", "eu.anthropic.claude-opus-5"],
    ["APAC inference profile", "apac.anthropic.claude-haiku-4-5"],
    ["GovCloud inference profile", "us-gov.anthropic.claude-sonnet-5"],
    [
      "inference-profile ARN",
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-5-20260101-v1:0",
    ],
  ])("raises the modern Claude ceiling for a %s", (_label, modelId) => {
    createModel("bedrock", modelId, 4);

    expect(bedrockConstructorArgs[0]).toMatchObject({ maxTokens: 16_384 });
  });

  // A ceiling above a model's own maximum is a Bedrock ValidationException, so
  // anything without a known-wide output window keeps the provider default.
  test.each([
    ["a non-Anthropic vendor", "meta.llama3-3-70b-instruct-v1:0"],
    ["an older Claude family", "anthropic.claude-3-5-sonnet-20241022-v2:0"],
    ["Claude 3 Haiku", "us.anthropic.claude-3-haiku-20240307-v1:0"],
    ["a custom or unrecognized ID", "my-private-deployment"],
  ])("leaves the provider default in place for %s", (_label, modelId) => {
    createModel("bedrock", modelId, 4);

    expect(bedrockConstructorArgs[0]).not.toHaveProperty("maxTokens");
  });

  test("lets an explicit run option win over the modern Claude default", () => {
    createModel("bedrock", "us.anthropic.claude-sonnet-5", 4, 8192);

    expect(bedrockConstructorArgs[0]).toMatchObject({ maxTokens: 8192 });
  });

  test("lets OPENWIKI_MAX_OUTPUT_TOKENS win for a model with no known ceiling", () => {
    process.env.OPENWIKI_MAX_OUTPUT_TOKENS = "2048";

    createModel("bedrock", "meta.llama3-3-70b-instruct-v1:0", 4);

    expect(bedrockConstructorArgs[0]).toMatchObject({ maxTokens: 2048 });
  });
});
