import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ChatBedrockConverse } from "@langchain/aws";
import { createModel } from "../src/agent/index.ts";

const ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "BEDROCK_AWS_ACCESS_KEY_ID",
  "BEDROCK_AWS_SECRET_ACCESS_KEY",
  "BEDROCK_AWS_SESSION_TOKEN",
  "AWS_REGION",
] as const;

const originalEnv = new Map(
  ENV_KEYS.map((key) => [key, process.env[key]] as const),
);

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.AWS_REGION = "us-east-1";
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

describe("Bedrock AWS SDK credential integration", () => {
  test("resolves standard temporary AWS environment credentials", async () => {
    process.env.AWS_ACCESS_KEY_ID = "standard-access";
    process.env.AWS_SECRET_ACCESS_KEY = "standard-secret";
    process.env.AWS_SESSION_TOKEN = "standard-session";

    const model = createModel(
      "bedrock",
      "anthropic.claude-sonnet-5",
      0,
    ) as ChatBedrockConverse;
    const credentials = await model.client.config.credentials();

    expect(credentials).toMatchObject({
      accessKeyId: "standard-access",
      secretAccessKey: "standard-secret",
      sessionToken: "standard-session",
    });
  });

  test("preserves the legacy Bedrock session token", async () => {
    process.env.BEDROCK_AWS_ACCESS_KEY_ID = "legacy-access";
    process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = "legacy-secret";
    process.env.BEDROCK_AWS_SESSION_TOKEN = "legacy-session";

    const model = createModel(
      "bedrock",
      "anthropic.claude-sonnet-5",
      0,
    ) as ChatBedrockConverse;
    const credentials = await model.client.config.credentials();

    expect(credentials).toMatchObject({
      accessKeyId: "legacy-access",
      secretAccessKey: "legacy-secret",
      sessionToken: "legacy-session",
    });
  });
});
