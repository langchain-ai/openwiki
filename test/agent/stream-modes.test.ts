import { afterEach, describe, expect, test } from "vitest";
import { resolveOpenAiCompatibleStreamMessages } from "../../src/config/constants.ts";
import { OPENAI_COMPATIBLE_STREAM_MESSAGES_ENV_KEY } from "../../src/config/constants.ts";

const original = process.env[OPENAI_COMPATIBLE_STREAM_MESSAGES_ENV_KEY];

afterEach(() => {
  if (original === undefined) {
    delete process.env[OPENAI_COMPATIBLE_STREAM_MESSAGES_ENV_KEY];
  } else {
    process.env[OPENAI_COMPATIBLE_STREAM_MESSAGES_ENV_KEY] = original;
  }
});

// Issue #659: openai-compatible endpoints that stream reasoning deltas before
// the first role:"assistant" delta (z.ai GLM) crash the agent loop when the
// "messages" stream mode forces chunk aggregation
// (ChatMessageChunk fails the wrapModelCall AIMessage check). The env opt-out
// must default to disabled and parse robustly.
describe("resolveOpenAiCompatibleStreamMessages", () => {
  test("defaults to false (safe non-streaming path)", () => {
    delete process.env[OPENAI_COMPATIBLE_STREAM_MESSAGES_ENV_KEY];

    expect(resolveOpenAiCompatibleStreamMessages()).toBe(false);
  });

  test("explicit true restores messages stream mode", () => {
    process.env[OPENAI_COMPATIBLE_STREAM_MESSAGES_ENV_KEY] = "true";

    expect(resolveOpenAiCompatibleStreamMessages()).toBe(true);
  });

  test("TRUE with surrounding whitespace is accepted", () => {
    process.env[OPENAI_COMPATIBLE_STREAM_MESSAGES_ENV_KEY] = "  TRUE  ";

    expect(resolveOpenAiCompatibleStreamMessages()).toBe(true);
  });

  test("any other value is treated as false", () => {
    for (const value of ["false", "1", "yes", "garbage", ""]) {
      expect(
        resolveOpenAiCompatibleStreamMessages({
          [OPENAI_COMPATIBLE_STREAM_MESSAGES_ENV_KEY]: value,
        }),
      ).toBe(false);
    }
  });
});
