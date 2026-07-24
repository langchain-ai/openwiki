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

const { createModel } = await import("../src/agent/index.ts");

const ENV_KEYS = [
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "BEDROCK_AWS_ACCESS_KEY_ID",
  "BEDROCK_AWS_REGION",
  "BEDROCK_AWS_SECRET_ACCESS_KEY",
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

    createModel("bedrock", "anthropic.claude-sonnet-5", 4);

    expect(bedrockConstructorArgs).toHaveLength(1);
    expect(bedrockConstructorArgs[0]).toMatchObject({
      maxRetries: 4,
      model: "anthropic.claude-sonnet-5",
      region: "us-east-1",
    });
    expect(bedrockConstructorArgs[0]).not.toHaveProperty("credentials");
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
