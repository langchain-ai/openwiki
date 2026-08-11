import type { CallbackHandlerMethods } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

/** Run-scoped provider-reported token accumulator. */
export interface TokenUsageTracker {
  /** Callback handler attached to the root agent run and inherited by children. */
  handler: CallbackHandlerMethods;

  /** Total tokens reported by completed model calls, or undefined when absent. */
  totalTokens(): number | undefined;
}

/** Narrow an unknown object-like value for provider-neutral metadata parsing. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Accept only finite non-negative token counts. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Read one completed LangChain model call's normalized token total. Prefer the
 * top-level `llmOutput.tokenUsage` aggregate, then fall back to generation
 * message usage metadata for providers that expose only that representation.
 */
export function totalTokensFromLlmResult(
  output: LLMResult,
): number | undefined {
  const llmOutput = isRecord(output.llmOutput) ? output.llmOutput : undefined;
  const tokenUsage = isRecord(llmOutput?.tokenUsage)
    ? llmOutput.tokenUsage
    : undefined;
  const aggregate = tokenCount(tokenUsage?.totalTokens);
  if (aggregate !== undefined) {
    return aggregate;
  }

  let total = 0;
  let observed = false;
  for (const generation of output.generations.flat()) {
    const generationRecord = isRecord(generation) ? generation : undefined;
    const message = isRecord(generationRecord?.message)
      ? generationRecord.message
      : undefined;
    const usage = isRecord(message?.usage_metadata)
      ? message.usage_metadata
      : undefined;
    const generationTotal = tokenCount(usage?.total_tokens);
    if (generationTotal !== undefined) {
      total += generationTotal;
      observed = true;
    }
  }

  return observed ? total : undefined;
}

/**
 * Create a fresh token accumulator for one OpenWiki run. The handler sees every
 * inherited model completion—including subagents, summarization, and calls
 * tagged out of the visible message stream—and deduplicates by LangChain run id.
 */
export function createTokenUsageTracker(): TokenUsageTracker {
  const completedRuns = new Set<string>();
  let total = 0;
  let observed = false;
  let incomplete = false;

  return {
    handler: {
      handleLLMEnd: (output, runId) => {
        if (completedRuns.has(runId)) {
          return;
        }
        completedRuns.add(runId);

        const runTokens = totalTokensFromLlmResult(output);
        if (runTokens === undefined) {
          incomplete = true;
          return;
        }

        total += runTokens;
        observed = true;
      },
    },
    totalTokens: () => (observed && !incomplete ? total : undefined),
  };
}
