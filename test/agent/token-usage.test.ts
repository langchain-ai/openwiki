import type { LLMResult } from "@langchain/core/outputs";
import { describe, expect, test } from "vitest";

import {
  createTokenUsageTracker,
  totalTokensFromLlmResult,
} from "../../src/agent/token-usage.ts";

function result(value: unknown): LLMResult {
  return value as LLMResult;
}

describe("OpenWiki token usage", () => {
  test("prefers the normalized top-level aggregate", () => {
    expect(
      totalTokensFromLlmResult(
        result({
          generations: [
            [{ message: { usage_metadata: { total_tokens: 99 } } }],
          ],
          llmOutput: { tokenUsage: { totalTokens: 42 } },
        }),
      ),
    ).toBe(42);
  });

  test("falls back to generation usage metadata", () => {
    expect(
      totalTokensFromLlmResult(
        result({
          generations: [
            [{ message: { usage_metadata: { total_tokens: 10 } } }],
            [{ message: { usage_metadata: { total_tokens: 7 } } }],
          ],
        }),
      ),
    ).toBe(17);
  });

  test("sums completed model runs once", () => {
    const tracker = createTokenUsageTracker();
    expect(tracker.totalTokens()).toBeUndefined();

    tracker.handler.handleLLMEnd?.(
      result({
        generations: [[]],
        llmOutput: { tokenUsage: { totalTokens: 12 } },
      }),
      "run-1",
    );
    tracker.handler.handleLLMEnd?.(
      result({
        generations: [[]],
        llmOutput: { tokenUsage: { totalTokens: 12 } },
      }),
      "run-1",
    );

    expect(tracker.totalTokens()).toBe(12);
  });

  test("does not expose a partial total when any model call omits usage", () => {
    const tracker = createTokenUsageTracker();

    tracker.handler.handleLLMEnd?.(
      result({
        generations: [[]],
        llmOutput: { tokenUsage: { totalTokens: 12 } },
      }),
      "run-1",
    );
    tracker.handler.handleLLMEnd?.(result({ generations: [[]] }), "run-2");

    expect(tracker.totalTokens()).toBeUndefined();
  });
});
