import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveModelId } from "../../src/agent/index.ts";
import { OPENWIKI_MODEL_ID_ENV_KEY } from "../../src/config/constants.ts";
import type { OpenWikiRunEvent } from "../../src/agent/types.ts";

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

describe("resolveModelId – provider/model mismatch warning", () => {
  test("warns (without failing) when the model belongs to a different provider", () => {
    // A known Anthropic model left configured while the provider is Gemini is a
    // likely misconfiguration. resolveModelId still returns the model (a gateway
    // may serve it) but must surface an actionable warning via onEvent and
    // stderr so a later opaque provider 400 is pre-empted.
    const events: OpenWikiRunEvent[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const modelId = resolveModelId(
        {
          modelId: "claude-haiku-4-5",
          debug: true,
          onEvent: (event) => events.push(event),
        },
        "gemini",
      );

      // The run is not blocked: the mismatched model is returned as-is.
      expect(modelId).toBe("claude-haiku-4-5");

      const warning = events.find(
        (event): event is Extract<OpenWikiRunEvent, { type: "text" }> =>
          event.type === "text",
      );
      expect(warning?.text).toContain("claude-haiku-4-5");
      expect(warning?.text).toMatch(/not a known/u);

      // The debug breadcrumb records the mismatch classification.
      expect(events.some((event) => event.type === "debug")).toBe(true);
      // The warning is mirrored to stderr so it survives a later failure.
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  test("does not warn when the model is valid for the configured provider", () => {
    const events: OpenWikiRunEvent[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      resolveModelId(
        { modelId: "claude-haiku-4-5", onEvent: (event) => events.push(event) },
        "anthropic",
      );

      expect(events).toHaveLength(0);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});
