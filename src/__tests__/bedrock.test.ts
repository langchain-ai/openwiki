process.env.OPENWIKI_TEST = "true";

import { test } from "node:test";
import assert from "node:assert";
import { ensureProviderKey, createModel } from "../agent/index.js";
import { needsCredentialSetup } from "../credentials.js";
import { resolveStartupCommand } from "../cli.js";
import type { CliCommand } from "../commands.js";

// Helper to temporarily mock/restore process.env variables
async function runWithEnv(envUpdates: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const originalEnv = { ...process.env };
  try {
    for (const [key, value] of Object.entries(envUpdates)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fn();
  } finally {
    restoreEnv(originalEnv);
  }
}

function restoreEnv(originalEnv: Record<string, string | undefined>) {
  // Restore original env
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value;
  }
}

test("AWS Bedrock - Region validation in ensureProviderKey", async () => {
  // Should throw when neither AWS_REGION nor AWS_DEFAULT_REGION is configured
  runWithEnv({ AWS_REGION: undefined, AWS_DEFAULT_REGION: undefined }, () => {
    assert.throws(() => ensureProviderKey("bedrock"), /AWS_REGION or AWS_DEFAULT_REGION is required/);
  });

  // Should NOT throw when AWS_REGION is set
  runWithEnv({ AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: undefined }, () => {
    assert.doesNotThrow(() => ensureProviderKey("bedrock"));
  });

  // Should NOT throw when AWS_DEFAULT_REGION is set
  runWithEnv({ AWS_REGION: undefined, AWS_DEFAULT_REGION: "us-west-2" }, () => {
    assert.doesNotThrow(() => ensureProviderKey("bedrock"));
  });
});

test("AWS Bedrock - IAM role / default credential chain flow in createModel", async () => {
  await runWithEnv(
    {
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
      AWS_SESSION_TOKEN: undefined,
    },
    async () => {
      const model = await createModel("bedrock", "us.anthropic.claude-3-5-sonnet-20241022-v2:0");
      const { ChatBedrockConverse } = await import("@langchain/aws");
      assert.ok(model instanceof ChatBedrockConverse);
      
      // Verify client credentials provider function is configured (enabling default chain)
      const credsProvider = (model as any).client?.config?.credentials;
      assert.strictEqual(typeof credsProvider, "function");
      assert.strictEqual(model.region, "us-east-1");
    }
  );
});

test("AWS Bedrock - Explicit credential flow in createModel", async () => {
  await runWithEnv(
    {
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "my-access-key-id",
      AWS_SECRET_ACCESS_KEY: "my-secret-access-key",
      AWS_SESSION_TOKEN: "my-session-token",
    },
    async () => {
      const model = await createModel("bedrock", "us.anthropic.claude-3-5-sonnet-20241022-v2:0");
      const { ChatBedrockConverse } = await import("@langchain/aws");
      assert.ok(model instanceof ChatBedrockConverse);
      
      // Verify custom explicit credentials are successfully mapped
      const credsProvider = (model as any).client?.config?.credentials;
      assert.strictEqual(typeof credsProvider, "function");
      const resolved = await credsProvider();
      assert.strictEqual(resolved.accessKeyId, "my-access-key-id");
      assert.strictEqual(resolved.secretAccessKey, "my-secret-access-key");
      assert.strictEqual(resolved.sessionToken, "my-session-token");
      assert.strictEqual(model.region, "us-east-1");
    }
  );
});

test("AWS Bedrock - Onboarding logic in needsCredentialSetup", () => {
  // Should need setup if provider is set to bedrock but no region is set
  runWithEnv(
    {
      OPENWIKI_PROVIDER: "bedrock",
      AWS_REGION: undefined,
      AWS_DEFAULT_REGION: undefined,
      OPENWIKI_MODEL_ID: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      LANGSMITH_API_KEY: "dummy-key",
    },
    () => {
      assert.strictEqual(needsCredentialSetup(), true);
    }
  );

  // Should NOT need setup if region is set and all other configs are present (IAM role case)
  runWithEnv(
    {
      OPENWIKI_PROVIDER: "bedrock",
      AWS_REGION: "us-east-1",
      AWS_DEFAULT_REGION: undefined,
      OPENWIKI_MODEL_ID: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      LANGSMITH_API_KEY: "dummy-key",
    },
    () => {
      assert.strictEqual(needsCredentialSetup(), false);
    }
  );
});

test("AWS Bedrock - Non-interactive validation in resolveStartupCommand", () => {
  const baseCommand: CliCommand = {
    kind: "run",
    exitCode: 0,
    command: "chat",
    dryRun: false,
    shouldStart: true,
    print: true,
    userMessage: "generate docs",
    modelId: null,
  };

  // Should return error command when neither region is set
  runWithEnv(
    {
      OPENWIKI_PROVIDER: "bedrock",
      AWS_REGION: undefined,
      AWS_DEFAULT_REGION: undefined,
    },
    () => {
      const resolved = resolveStartupCommand(baseCommand);
      assert.strictEqual(resolved.kind, "error");
      assert.match(resolved.message || "", /AWS_REGION or AWS_DEFAULT_REGION is required/);
    }
  );

  // Should return the original command successfully when AWS_REGION is set
  runWithEnv(
    {
      OPENWIKI_PROVIDER: "bedrock",
      AWS_REGION: "us-east-1",
      AWS_DEFAULT_REGION: undefined,
    },
    () => {
      const resolved = resolveStartupCommand(baseCommand);
      assert.deepStrictEqual(resolved, baseCommand);
    }
  );

  // Should return the original command successfully when AWS_DEFAULT_REGION is set
  runWithEnv(
    {
      OPENWIKI_PROVIDER: "bedrock",
      AWS_REGION: undefined,
      AWS_DEFAULT_REGION: "us-west-2",
    },
    () => {
      const resolved = resolveStartupCommand(baseCommand);
      assert.deepStrictEqual(resolved, baseCommand);
    }
  );
});
