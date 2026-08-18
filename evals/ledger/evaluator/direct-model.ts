import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ZodError, type ZodType } from "zod";

import { EvaluationError } from "../core/errors.js";

/**
 * Default wall-clock deadline for one evaluator model request.
 */
export const DEFAULT_EVALUATOR_TIMEOUT_MS = 300_000;

/**
 * Maximum number of evaluator-level attempts for one structured request.
 */
const MAX_ATTEMPTS = 2;

/**
 * Names the bounded semantic operation being performed by a model request.
 */
export type DirectEvaluationPass =
  "forgetting" | "precision-extraction" | "precision-judgment";

/**
 * Inputs for one bounded structured evaluator request.
 */
export interface DirectModelCallOptions<T extends Record<string, unknown>> {
  /**
   * Chat model used for the semantic judgment.
   */
  model: BaseChatModel;

  /**
   * Evaluation operation used in diagnostics.
   */
  pass: DirectEvaluationPass;

  /**
   * Checkpoint being evaluated, used in diagnostics.
   */
  checkpointId: string;

  /**
   * Stable evaluator instructions supplied as the system message.
   */
  systemPrompt: string;

  /**
   * Bounded facts, excerpts, or assertions supplied as the user message.
   */
  taskPrompt: string;

  /**
   * Schema every provider response must satisfy.
   */
  schema: ZodType<T>;

  /**
   * Wall-clock deadline for each individual attempt.
   *
   * @default 300000
   */
  timeoutMs?: number;

  /**
   * Optional semantic completeness validation applied after schema parsing.
   *
   * @default undefined only schema parsing is enforced when absent
   */
  validate?: (result: T) => void;
}

/**
 * Convert an unknown failure into a bounded diagnostic that cannot flood the
 * terminal with a provider response or structured-output payload.
 *
 * @param error - Failure raised by invocation, parsing, or validation.
 * @param prompts - Prompt strings that must never be repeated in diagnostics.
 *
 * @returns Short diagnostic text for the final EvaluationError.
 */
function summarizeError(error: unknown, prompts: string[]): string {
  if (error instanceof ZodError) {
    return "Structured response failed schema validation.";
  }

  if (error instanceof Error) {
    const redactedMessage = prompts
      .filter((prompt) => prompt.length > 0)
      .sort((a, b) => b.length - a.length)
      .reduce(
        (message, prompt) => message.replaceAll(prompt, "[prompt omitted]"),
        error.message,
      );
    const compactMessage = redactedMessage.replace(/\s+/g, " ").trim();
    const boundedMessage = compactMessage.slice(0, 500);

    return boundedMessage.length > 0
      ? `${error.name}: ${boundedMessage}`
      : error.name;
  }

  return "Unknown evaluator failure.";
}

/**
 * Invoke one structured-output attempt with a hard wall-clock deadline. The
 * abort signal asks the provider transport to cancel; the timeout rejection also
 * guarantees this caller stops waiting if a transport ignores cancellation.
 *
 * @param options - Direct model-call configuration.
 * @param timeoutMs - Validated per-attempt deadline.
 *
 * @returns Parsed and semantically validated structured output.
 */
async function invokeAttempt<T extends Record<string, unknown>>(
  options: DirectModelCallOptions<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      const error = new Error(`Timed out after ${timeoutMs}ms.`);
      error.name = "EvaluatorTimeoutError";
      reject(error);
    }, timeoutMs);
  });

  try {
    const runnable = options.model.withStructuredOutput<T>(options.schema);
    const invocation = runnable.invoke(
      [
        { role: "system", content: options.systemPrompt },
        { role: "user", content: options.taskPrompt },
      ],
      { signal: controller.signal },
    );
    const raw = await Promise.race([invocation, timeout]);
    const parsed = options.schema.parse(raw);

    options.validate?.(parsed);
    return parsed;
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Run one direct structured evaluator request with a fixed two-attempt ceiling.
 * Each attempt gets a fresh abort controller and deadline. No agent, tool, or
 * recursive model loop is involved.
 *
 * @param options - Direct model-call configuration.
 *
 * @returns Parsed and semantically validated structured output.
 *
 * @throws EvaluationError when configuration is invalid or both attempts fail.
 */
export async function invokeStructuredModel<T extends Record<string, unknown>>(
  options: DirectModelCallOptions<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EVALUATOR_TIMEOUT_MS;

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new EvaluationError(
      `Evaluator checkpoint "${options.checkpointId}" pass "${options.pass}" requires a positive integer timeoutMs.`,
    );
  }

  let finalError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await invokeAttempt(options, timeoutMs);
    } catch (error) {
      finalError = error;
    }
  }

  throw new EvaluationError(
    `Evaluator checkpoint "${options.checkpointId}" pass "${options.pass}" failed after ${MAX_ATTEMPTS} attempts: ${summarizeError(finalError, [options.systemPrompt, options.taskPrompt])}`,
  );
}
