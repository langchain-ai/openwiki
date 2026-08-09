import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import { toolStrategy } from "langchain";
import type { ZodType } from "zod";

import { EvaluationError } from "../core/errors.js";

/**
 * Options for one evaluator pass.
 */
export interface EvaluatorPassOptions<T> {
  /**
   * The chat model to run the pass with.
   */
  model: BaseChatModel;

  /**
   * Absolute path to the evaluation workspace the agent may read: the generated
   * wiki under `artifact/` plus the active ledger as `truth-ledger.json`. The
   * agent is sandboxed to this directory.
   */
  workspaceDir: string;

  /**
   * The system prompt for the pass.
   */
  systemPrompt: string;

  /**
   * The task prompt for the pass.
   */
  taskPrompt: string;

  /**
   * The schema the agent's structured response must satisfy.
   */
  schema: ZodType<T>;

  /**
   * Optional completeness check run after schema parsing. It should throw when
   * the parsed output is unusable (for example, a requested target has no
   * verdict or a duplicate one), which triggers the same single retry as a
   * schema failure.
   *
   * @default undefined - only schema validity is enforced.
   */
  validate?: (parsed: T) => void;
}

/**
 * Run one evaluator pass and return its validated output. The agent is given no
 * tools of its own; its only capability is reading the workspace through the
 * sandboxed filesystem backend. The structured response is re-parsed with the
 * same schema so defaults are applied and malformed output is rejected, then the
 * optional completeness check runs. A single retry absorbs a transient bad
 * generation or an incomplete result; a second failure is fatal.
 *
 * @param options - The pass options.
 *
 * @returns The validated pass output.
 *
 * @throws EvaluationError when the agent's output fails validation twice.
 */
export async function runEvaluatorPass<T>(
  options: EvaluatorPassOptions<T>,
): Promise<T> {
  const backend = new FilesystemBackend({
    rootDir: options.workspaceDir,
    virtualMode: true,
    maxFileSizeMb: 5,
  });

  // Wrap the schema as a tool-calling response strategy rather than passing the
  // bare schema: function-calling structured output is the most broadly supported
  // path across the providers a benchmark may evaluate with, and it composes with
  // the read-only filesystem tools the backend injects.
  const agent = createDeepAgent({
    model: options.model,
    tools: [],
    systemPrompt: options.systemPrompt,
    responseFormat: toolStrategy(options.schema),
    backend,
  });

  const attempt = async (): Promise<T> => {
    const result = (await agent.invoke({
      messages: [{ role: "user", content: options.taskPrompt }],
    })) as { structuredResponse?: unknown };

    const parsed = options.schema.parse(result.structuredResponse);

    options.validate?.(parsed);

    return parsed;
  };

  try {
    return await attempt();
  } catch {
    try {
      return await attempt();
    } catch (error) {
      throw new EvaluationError(
        `Evaluator pass failed validation after retry: ${(error as Error).message}`,
      );
    }
  }
}
