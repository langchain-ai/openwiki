import { describe, expect, test } from "vitest";

import { buildCredentialEnvUpdates } from "../../../src/setup/credentials/persistence.ts";
import type { CompleteSetupOptions } from "../../../src/setup/credentials/types.ts";
import type { CodexTokens } from "../../../src/agent/openai-chatgpt-oauth.ts";

/**
 * A `CompleteSetupOptions` with every collectible field defaulted to "not
 * collected" (null). Each test overrides only the fields it exercises, so an
 * assertion about one provider setting is not entangled with the others.
 */
function makeOptions(
  overrides: Partial<CompleteSetupOptions> = {},
): CompleteSetupOptions {
  return {
    nextApiKey: null,
    nextBaseUrl: null,
    nextGcpLocation: null,
    nextGcpProject: null,
    nextLangSmithKey: null,
    nextModelId: null,
    nextProvider: "anthropic",
    nextRegion: null,
    nextSecretKey: null,
    runMode: "code",
    ...overrides,
  };
}

/** A fabricated environment so tests never read the real `~/.openwiki/.env`. */
function makeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe("buildCredentialEnvUpdates", () => {
  test("writes the provider only when it differs from the current env", () => {
    const changed = buildCredentialEnvUpdates(
      makeOptions({ nextProvider: "anthropic" }),
      makeEnv({ OPENWIKI_PROVIDER: "openai" }),
    );
    expect(changed.OPENWIKI_PROVIDER).toBe("anthropic");

    const unchanged = buildCredentialEnvUpdates(
      makeOptions({ nextProvider: "anthropic" }),
      makeEnv({ OPENWIKI_PROVIDER: "anthropic" }),
    );
    expect(unchanged).not.toHaveProperty("OPENWIKI_PROVIDER");
  });

  test("maps the api key onto the selected provider's env key", () => {
    const anthropic = buildCredentialEnvUpdates(
      makeOptions({ nextProvider: "anthropic", nextApiKey: "sk-ant-123" }),
      makeEnv({ OPENWIKI_PROVIDER: "anthropic" }),
    );
    expect(anthropic.ANTHROPIC_API_KEY).toBe("sk-ant-123");
    expect(anthropic).not.toHaveProperty("OPENAI_API_KEY");

    const openai = buildCredentialEnvUpdates(
      makeOptions({ nextProvider: "openai", nextApiKey: "sk-oai-456" }),
      makeEnv({ OPENWIKI_PROVIDER: "openai" }),
    );
    expect(openai.OPENAI_API_KEY).toBe("sk-oai-456");
    expect(openai).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  test("maps bedrock secret key and region onto their provider env keys", () => {
    const updates = buildCredentialEnvUpdates(
      makeOptions({
        nextProvider: "bedrock",
        nextApiKey: "AKIA-access",
        nextSecretKey: "aws-secret",
        nextRegion: "us-east-1",
      }),
      makeEnv({ OPENWIKI_PROVIDER: "bedrock" }),
    );
    expect(updates.BEDROCK_AWS_ACCESS_KEY_ID).toBe("AKIA-access");
    expect(updates.BEDROCK_AWS_SECRET_ACCESS_KEY).toBe("aws-secret");
    expect(updates.BEDROCK_AWS_REGION).toBe("us-east-1");
  });

  test("maps gcp project and location onto the vertex provider env keys", () => {
    const updates = buildCredentialEnvUpdates(
      makeOptions({
        nextProvider: "gemini-enterprise",
        nextGcpProject: "my-project",
        nextGcpLocation: "us-central1",
      }),
      makeEnv({ OPENWIKI_PROVIDER: "gemini-enterprise" }),
    );
    expect(updates.GOOGLE_CLOUD_PROJECT).toBe("my-project");
    expect(updates.GOOGLE_CLOUD_LOCATION).toBe("us-central1");
  });

  test("writes the model id when one was collected", () => {
    const updates = buildCredentialEnvUpdates(
      makeOptions({ nextProvider: "anthropic", nextModelId: "claude-x" }),
      makeEnv({ OPENWIKI_PROVIDER: "anthropic" }),
    );
    expect(updates.OPENWIKI_MODEL_ID).toBe("claude-x");
  });

  test("writes or clears an explicitly selected reasoning effort", () => {
    const selected = buildCredentialEnvUpdates(
      makeOptions({
        nextProvider: "openai",
        nextReasoningEffort: "max",
      }),
      makeEnv({ OPENWIKI_PROVIDER: "openai" }),
    );
    expect(selected.OPENWIKI_REASONING_EFFORT).toBe("max");

    const providerDefault = buildCredentialEnvUpdates(
      makeOptions({
        nextProvider: "openai",
        nextReasoningEffort: "",
      }),
      makeEnv({ OPENWIKI_PROVIDER: "openai" }),
    );
    expect(providerDefault.OPENWIKI_REASONING_EFFORT).toBe("");
  });

  test("turns tracing on and pins the project for a non-empty langsmith key", () => {
    const updates = buildCredentialEnvUpdates(
      makeOptions({ nextProvider: "anthropic", nextLangSmithKey: "ls-key" }),
      makeEnv({ OPENWIKI_PROVIDER: "anthropic" }),
    );
    expect(updates.LANGSMITH_API_KEY).toBe("ls-key");
    expect(updates.LANGCHAIN_PROJECT).toBe("openwiki");
    expect(updates.LANGCHAIN_TRACING_V2).toBe("true");
  });

  test("treats a blank langsmith key as an explicit tracing off switch", () => {
    const updates = buildCredentialEnvUpdates(
      makeOptions({ nextProvider: "anthropic", nextLangSmithKey: "" }),
      makeEnv({ OPENWIKI_PROVIDER: "anthropic" }),
    );
    expect(updates.LANGSMITH_API_KEY).toBe("");
    expect(updates.LANGCHAIN_TRACING_V2).toBe("false");
    expect(updates).not.toHaveProperty("LANGCHAIN_PROJECT");
  });

  test("expands oauth tokens into their env keys when present", () => {
    const tokens: CodexTokens = {
      access: "access-token",
      refresh: "refresh-token",
      expiresAtMs: 1_700_000_000_000,
      accountId: "acct-1",
      email: null,
      planType: null,
    };
    const updates = buildCredentialEnvUpdates(
      makeOptions({ nextProvider: "openai-chatgpt", nextOAuthTokens: tokens }),
      makeEnv({ OPENWIKI_PROVIDER: "openai-chatgpt" }),
    );
    expect(updates.OPENAI_CHATGPT_ACCESS_TOKEN).toBe("access-token");
    expect(updates.OPENAI_CHATGPT_REFRESH_TOKEN).toBe("refresh-token");
    expect(updates.OPENAI_CHATGPT_ACCOUNT_ID).toBe("acct-1");
  });

  test("omits every setting the wizard did not collect", () => {
    const updates = buildCredentialEnvUpdates(
      makeOptions({ nextProvider: "anthropic" }),
      makeEnv({ OPENWIKI_PROVIDER: "anthropic" }),
    );
    expect(updates).toEqual({});
  });
});
