import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const bedrockArgs: Array<Record<string, unknown>> = [];

vi.mock("@langchain/aws", () => ({
  ChatBedrockConverse: class {
    constructor(options: Record<string, unknown>) {
      bedrockArgs.push(options);
    }
  },
}));

const { createModel } = await import("../src/agent/index.ts");

const ACCESS_KEY = "BEDROCK_AWS_ACCESS_KEY_ID";
const SECRET_KEY = "BEDROCK_AWS_SECRET_ACCESS_KEY";
const BEDROCK_SESSION_TOKEN = "BEDROCK_AWS_SESSION_TOKEN";
const AWS_SESSION_TOKEN = "AWS_SESSION_TOKEN";
const REGION_KEY = "BEDROCK_AWS_REGION";
const MODEL_ID = "us.anthropic.claude-sonnet-5";
const REGION = "us-west-2";
const ACCESS_VALUE = "access";
const SECRET_VALUE = "secret";
const AWS_SESSION_VALUE = "aws-session";
const BEDROCK_SESSION_VALUE = "bedrock-session";
const SESSION_VALUE = "session";
const ENV_KEYS = [
  ACCESS_KEY,
  SECRET_KEY,
  BEDROCK_SESSION_TOKEN,
  AWS_SESSION_TOKEN,
  REGION_KEY,
] as const;

let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  savedEnv = {} as Record<(typeof ENV_KEYS)[number], string | undefined>;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env[REGION_KEY] = REGION;
  bedrockArgs.length = 0;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("createModel bedrock credentials", () => {
  test("omits explicit credentials so the AWS SDK default chain can run", () => {
    createModel("bedrock", MODEL_ID, 2);

    expect(bedrockArgs).toHaveLength(1);
    expect(bedrockArgs[0]).not.toHaveProperty("credentials");
    expect(bedrockArgs[0]?.region).toBe(REGION);
    expect(bedrockArgs[0]?.maxRetries).toBe(2);
  });

  test("passes session tokens with complete static temporary credentials", () => {
    process.env[ACCESS_KEY] = ACCESS_VALUE;
    process.env[SECRET_KEY] = SECRET_VALUE;
    process.env[AWS_SESSION_TOKEN] = SESSION_VALUE;

    createModel("bedrock", MODEL_ID, 0);

    expect(bedrockArgs[0]?.credentials).toEqual({
      accessKeyId: ACCESS_VALUE,
      secretAccessKey: SECRET_VALUE,
      sessionToken: SESSION_VALUE,
    });
  });

  test("prefers the Bedrock-specific session token override", () => {
    process.env[ACCESS_KEY] = ACCESS_VALUE;
    process.env[SECRET_KEY] = SECRET_VALUE;
    process.env[AWS_SESSION_TOKEN] = AWS_SESSION_VALUE;
    process.env[BEDROCK_SESSION_TOKEN] = BEDROCK_SESSION_VALUE;

    createModel("bedrock", MODEL_ID, 0);

    expect(bedrockArgs[0]?.credentials).toEqual({
      accessKeyId: ACCESS_VALUE,
      secretAccessKey: SECRET_VALUE,
      sessionToken: BEDROCK_SESSION_VALUE,
    });
  });
});
