import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createModelRoute,
  isModelFallbackDisabled,
  resolveOpenRouterMaxInputTokens,
} from "../src/agent/index.ts";
import { OPENROUTER_FALLBACK_MODEL_IDS } from "../src/constants.ts";

const FALLBACK_ENV_KEY = "OPENWIKI_DISABLE_MODEL_FALLBACK";
let previousFallbackValue: string | undefined;

beforeEach(() => {
  previousFallbackValue = process.env[FALLBACK_ENV_KEY];
  delete process.env[FALLBACK_ENV_KEY];
});

afterEach(() => {
  if (previousFallbackValue === undefined) {
    delete process.env[FALLBACK_ENV_KEY];
  } else {
    process.env[FALLBACK_ENV_KEY] = previousFallbackValue;
  }
});

describe("isModelFallbackDisabled", () => {
  test('only reports true for exactly "1"', () => {
    process.env[FALLBACK_ENV_KEY] = "1";
    expect(isModelFallbackDisabled()).toBe(true);

    delete process.env[FALLBACK_ENV_KEY];
    expect(isModelFallbackDisabled()).toBe(false);

    process.env[FALLBACK_ENV_KEY] = "true";
    expect(isModelFallbackDisabled()).toBe(false);
  });
});

describe("createModelRoute", () => {
  test("non-openrouter providers never get a fallback list", () => {
    expect(createModelRoute("anthropic", "claude-sonnet-5")).toEqual([
      "claude-sonnet-5",
    ]);
  });

  test("openrouter gets the primary model plus fallback ids by default", () => {
    const route = createModelRoute("openrouter", "z-ai/glm-5.2");
    expect(route[0]).toBe("z-ai/glm-5.2");
    for (const fallback of OPENROUTER_FALLBACK_MODEL_IDS) {
      expect(route).toContain(fallback);
    }
  });

  test("does not duplicate the primary model when it is also a fallback id", () => {
    const [primary] = OPENROUTER_FALLBACK_MODEL_IDS;
    const route = createModelRoute("openrouter", primary);
    expect(route.filter((id) => id === primary)).toHaveLength(1);
  });

  test("OPENWIKI_DISABLE_MODEL_FALLBACK=1 collapses openrouter to a single model", () => {
    process.env[FALLBACK_ENV_KEY] = "1";
    expect(createModelRoute("openrouter", "z-ai/glm-5.2")).toEqual([
      "z-ai/glm-5.2",
    ]);
  });
});

describe("resolveOpenRouterMaxInputTokens", () => {
  test("returns undefined when unset", () => {
    expect(resolveOpenRouterMaxInputTokens(undefined)).toBeUndefined();
  });

  test("returns undefined for non-numeric values", () => {
    expect(resolveOpenRouterMaxInputTokens("not-a-number")).toBeUndefined();
  });

  test("parses a valid integer string", () => {
    expect(resolveOpenRouterMaxInputTokens("15000")).toBe(15000);
  });
});
