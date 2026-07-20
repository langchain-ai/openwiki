import { afterEach, describe, expect, test } from "vitest";
import { resolveModelId } from "../src/agent/index.ts";
import { OPENWIKI_MODEL_ID_ENV_KEY } from "../src/constants.ts";

const originalModelId = process.env[OPENWIKI_MODEL_ID_ENV_KEY];

afterEach(() => {
  if (originalModelId === undefined) {
    delete process.env[OPENWIKI_MODEL_ID_ENV_KEY];
  } else {
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] = originalModelId;
  }
});

describe("resolveModelId", () => {
  test("uses the provider's first preset when nothing is configured", () => {
    delete process.env[OPENWIKI_MODEL_ID_ENV_KEY];

    expect(resolveModelId({}, "anthropic")).toBe("claude-haiku-4-5");
  });

  test("prefers an explicit option over the env var and the preset", () => {
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] = "claude-opus-4-8";

    expect(resolveModelId({ modelId: "claude-sonnet-5" }, "anthropic")).toBe(
      "claude-sonnet-5",
    );
  });

  test.each(["bedrock", "openai-compatible"] as const)(
    "requires an explicit model ID for %s, which has no presets",
    (provider) => {
      delete process.env[OPENWIKI_MODEL_ID_ENV_KEY];

      expect(() => resolveModelId({}, provider)).toThrow(
        new RegExp(`${OPENWIKI_MODEL_ID_ENV_KEY}.*required`, "u"),
      );
    },
  );

  test.each(["bedrock", "openai-compatible"] as const)(
    "accepts an explicit model ID for %s from the env var",
    (provider) => {
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] = "custom-model-id";

      expect(resolveModelId({}, provider)).toBe("custom-model-id");
    },
  );

  test("rejects an invalid configured model ID", () => {
    expect(() =>
      resolveModelId({ modelId: "http://evil.example" }, "anthropic"),
    ).toThrow(/Invalid model ID/u);
  });
});
