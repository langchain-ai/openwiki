import { afterEach, describe, expect, test } from "vitest";
import { getInitialStep, needsCredentialSetup } from "../src/credentials.tsx";

const ENV_KEYS = [
  "LANGSMITH_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENWIKI_MODEL_ID",
  "OPENWIKI_PROVIDER",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const originalValue = originalEnv.get(key);

    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
});

describe("needsCredentialSetup", () => {
  test("requires provider setup for an invalid configured provider", () => {
    process.env.OPENWIKI_PROVIDER = "bogus";
    process.env.OPENROUTER_API_KEY = "sk-or-v1-placeholder";
    process.env.OPENWIKI_MODEL_ID = "z-ai/glm-5.2";
    process.env.LANGSMITH_API_KEY = "lsv2_placeholder";

    expect(needsCredentialSetup()).toBe(true);
  });

  test("anthropic-aws still needs setup when the AWS region is missing", () => {
    // Everything else is present, so only the region/workspace gate can flip
    // this to true — proving the new AWS steps are part of the gate.
    process.env.OPENWIKI_PROVIDER = "anthropic-aws";
    process.env.ANTHROPIC_AWS_API_KEY = "sk-aws-placeholder";
    process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_placeholder";
    process.env.OPENWIKI_MODEL_ID = "claude-sonnet-5";
    process.env.LANGSMITH_API_KEY = "lsv2_placeholder";
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.ANTHROPIC_AWS_BASE_URL;

    expect(needsCredentialSetup()).toBe(true);
  });

  test("anthropic-aws still needs setup when the workspace ID is missing", () => {
    process.env.OPENWIKI_PROVIDER = "anthropic-aws";
    process.env.ANTHROPIC_AWS_API_KEY = "sk-aws-placeholder";
    process.env.AWS_REGION = "us-west-2";
    process.env.OPENWIKI_MODEL_ID = "claude-sonnet-5";
    process.env.LANGSMITH_API_KEY = "lsv2_placeholder";
    delete process.env.ANTHROPIC_AWS_WORKSPACE_ID;

    expect(needsCredentialSetup()).toBe(true);
  });
});

describe("getInitialStep for the anthropic-aws wizard", () => {
  function cleanAwsEnv() {
    process.env.OPENWIKI_PROVIDER = "anthropic-aws";
    delete process.env.ANTHROPIC_AWS_API_KEY;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.ANTHROPIC_AWS_BASE_URL;
    delete process.env.ANTHROPIC_AWS_WORKSPACE_ID;
    delete process.env.OPENWIKI_MODEL_ID;
  }

  test("starts at the API key step when no credential is present", () => {
    cleanAwsEnv();

    expect(getInitialStep(null, "anthropic-aws")).toBe("api-key");
  });

  test("routes to the AWS region step once the API key is set", () => {
    cleanAwsEnv();
    process.env.ANTHROPIC_AWS_API_KEY = "sk-aws-placeholder";

    expect(getInitialStep(null, "anthropic-aws")).toBe("aws-region");
  });

  test("routes to the workspace step once the region is set", () => {
    cleanAwsEnv();
    process.env.ANTHROPIC_AWS_API_KEY = "sk-aws-placeholder";
    process.env.AWS_REGION = "us-west-2";

    expect(getInitialStep(null, "anthropic-aws")).toBe("aws-workspace-id");
  });

  test("skips the region step when ANTHROPIC_AWS_BASE_URL is set", () => {
    cleanAwsEnv();
    process.env.ANTHROPIC_AWS_API_KEY = "sk-aws-placeholder";
    process.env.ANTHROPIC_AWS_BASE_URL = "https://proxy.example/anthropic";

    expect(getInitialStep(null, "anthropic-aws")).toBe("aws-workspace-id");
  });

  test("advances to the model step once region and workspace are set", () => {
    cleanAwsEnv();
    process.env.ANTHROPIC_AWS_API_KEY = "sk-aws-placeholder";
    process.env.AWS_REGION = "us-west-2";
    process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_placeholder";

    expect(getInitialStep(null, "anthropic-aws")).toBe("model");
  });
});
