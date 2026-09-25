import path from "node:path";

import { LedgerError } from "../core/errors.js";

/**
 * Fully resolved command-line configuration for evaluator-only replay.
 */
export interface ReevaluationConfig {
  /** Print every stale and hallucinated claim beneath each checkpoint. */
  verbose: boolean;

  /**
   * Absolute benchmark directory.
   */
  benchmarkDir: string;

  /**
   * Absolute completed run directory supplying immutable inputs.
   */
  sourceRunDir: string;

  /**
   * Absolute directory where the new evaluation result is written.
   */
  resultsDir: string;

  /**
   * Evaluator provider id.
   */
  provider: string;

  /**
   * Concrete evaluator model id.
   */
  evaluatorModelId: string;
}

/**
 * Parsed evaluator-only command-line arguments before environment defaults and
 * absolute path resolution.
 */
interface ReevaluationArgs {
  /** Whether detailed incorrect-claim output is enabled. */
  verbose?: boolean;

  /**
   * Benchmark directory argument.
   */
  benchmark?: string;

  /**
   * Completed source run directory argument.
   */
  run?: string;

  /**
   * Optional results directory override.
   */
  results?: string;

  /**
   * Optional evaluator model override.
   */
  evaluatorModel?: string;
}

/**
 * Supported evaluator-only flags and their destination properties.
 */
const FLAGS: Record<string, Exclude<keyof ReevaluationArgs, "verbose">> = {
  "--benchmark": "benchmark",
  "--run": "run",
  "--results": "results",
  "--evaluator-model": "evaluatorModel",
};

/**
 * Parse evaluator-only arguments with strict unknown-flag and missing-value
 * handling.
 *
 * @param argv - Arguments after the script name.
 *
 * @returns Parsed arguments.
 *
 * @throws LedgerError when a flag is unknown or lacks a value.
 */
function parseReevaluationArgs(argv: string[]): ReevaluationArgs {
  const parsed: ReevaluationArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);

    if (flag === "--verbose") {
      if (equals !== -1) {
        throw new LedgerError(`"--verbose" does not accept a value.`);
      }
      parsed.verbose = true;
      continue;
    }

    const key = FLAGS[flag];

    if (key === undefined) {
      throw new LedgerError(`Unknown argument "${token}".`);
    }

    const value = equals === -1 ? argv[index + 1] : token.slice(equals + 1);

    if (value === undefined || value.length === 0) {
      throw new LedgerError(`Missing value for "${flag}".`);
    }

    parsed[key] = value;

    if (equals === -1) {
      index += 1;
    }
  }

  return parsed;
}

/**
 * Resolve evaluator-only CLI arguments and environment defaults into concrete
 * paths and model configuration.
 *
 * @param argv - Arguments after the script name.
 * @param env - Process environment containing provider and model defaults.
 * @param evalDir - Absolute `evals/ledger` directory used for default results.
 *
 * @returns Complete evaluator-only configuration.
 *
 * @throws LedgerError when a required benchmark, run, provider, or model is absent.
 */
export function resolveReevaluationConfig(
  argv: string[],
  env: NodeJS.ProcessEnv,
  evalDir: string,
): ReevaluationConfig {
  const args = parseReevaluationArgs(argv);

  if (args.benchmark === undefined) {
    throw new LedgerError(
      "A benchmark directory is required: --benchmark <dir>.",
    );
  }

  if (args.run === undefined) {
    throw new LedgerError(
      "A completed run directory is required: --run <dir>.",
    );
  }

  const provider = env.OPENWIKI_PROVIDER;

  if (provider === undefined || provider.length === 0) {
    throw new LedgerError("OPENWIKI_PROVIDER must be set in the environment.");
  }

  const evaluatorModelId =
    args.evaluatorModel ??
    env.LEDGER_EVALUATOR_MODEL_ID ??
    env.OPENWIKI_MODEL_ID;

  if (evaluatorModelId === undefined || evaluatorModelId.length === 0) {
    throw new LedgerError(
      "An evaluator model id is required. Set --evaluator-model, LEDGER_EVALUATOR_MODEL_ID, or OPENWIKI_MODEL_ID.",
    );
  }

  return {
    verbose: args.verbose === true,
    benchmarkDir: path.resolve(args.benchmark),
    sourceRunDir: path.resolve(args.run),
    resultsDir:
      args.results === undefined
        ? path.join(evalDir, ".results")
        : path.resolve(args.results),
    provider,
    evaluatorModelId,
  };
}
