import path from "node:path";

import type { ParsedArgs } from "./args.js";
import { LedgerError } from "../core/errors.js";
import type { LedgerRunConfig } from "../core/types.js";

/**
 * Directory name run outputs are written under, inside the eval directory.
 */
const DEFAULT_RESULTS_DIRNAME = ".results";

/**
 * Resolve a complete run config, or throw with actionable guidance. Provider
 * comes from `OPENWIKI_PROVIDER`; the system model from `--system-model` or
 * `OPENWIKI_MODEL_ID`; the evaluator model from `--evaluator-model` or
 * `LEDGER_EVALUATOR_MODEL_ID`, falling back to the system model. The evaluator
 * model must resolve to a concrete id, because the evaluator constructs its
 * model directly rather than deferring to OpenWiki's default resolution.
 *
 * @param args - The parsed CLI arguments.
 * @param env - The process environment.
 * @param evalDir - Absolute path to the `evals/ledger` directory, used to resolve
 *   the default results directory.
 *
 * @returns The resolved run config.
 *
 * @throws LedgerError when a required value is missing.
 */
export function resolveRunConfig(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
  evalDir: string,
): LedgerRunConfig {
  if (args.benchmark === undefined) {
    throw new LedgerError(
      "A benchmark directory is required: --benchmark <dir>.",
    );
  }

  const provider = env.OPENWIKI_PROVIDER;

  if (provider === undefined || provider.length === 0) {
    throw new LedgerError("OPENWIKI_PROVIDER must be set in the environment.");
  }

  const systemModelId = args.systemModel ?? env.OPENWIKI_MODEL_ID ?? undefined;
  const evaluatorModelId =
    args.evaluatorModel ?? env.LEDGER_EVALUATOR_MODEL_ID ?? systemModelId;

  if (evaluatorModelId === undefined) {
    throw new LedgerError(
      "An evaluator model id is required. Set --evaluator-model, LEDGER_EVALUATOR_MODEL_ID, or a system model id it can fall back to.",
    );
  }

  return {
    benchmarkDir: path.resolve(args.benchmark),
    provider,
    systemModelId,
    evaluatorModelId,
    resultsDir: args.results
      ? path.resolve(args.results)
      : path.join(evalDir, DEFAULT_RESULTS_DIRNAME),
  };
}
