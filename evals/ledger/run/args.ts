import { LedgerError } from "../core/errors.js";

/**
 * Parsed command-line arguments for a LEDGER run.
 */
export interface ParsedArgs {
  /** Print every stale and hallucinated claim beneath each checkpoint. */
  verbose?: boolean;

  /**
   * Path to the benchmark directory (required).
   */
  benchmark?: string;

  /**
   * Override for the results directory.
   *
   * @default the eval resolves a default under `evals/ledger/.results`
   */
  results?: string;

  /**
   * Override for the system-under-test model id.
   *
   * @default OpenWiki's default model for the provider
   */
  systemModel?: string;

  /**
   * Override for the evaluator model id.
   *
   * @default falls back to the system model id
   */
  evaluatorModel?: string;
}

/**
 * Map from a long flag to the `ParsedArgs` key it sets. Acts as the allowlist:
 * any token whose flag is not a key here is rejected.
 */
const FLAGS: Record<string, Exclude<keyof ParsedArgs, "verbose">> = {
  "--benchmark": "benchmark",
  "--results": "results",
  "--system-model": "systemModel",
  "--evaluator-model": "evaluatorModel",
};

/**
 * Parse LEDGER CLI arguments from a raw argv slice. Supports both `--key value` and
 * `--key=value`. Unknown flags and missing values are hard errors rather than
 * being silently ignored, so a typo never runs with a surprising default.
 *
 * @param argv - Arguments after the script name (typically `process.argv.slice(2)`).
 *
 * @returns The parsed arguments.
 *
 * @throws LedgerError on an unknown flag or a missing value.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);

    if (flag === "--verbose") {
      if (eq !== -1) {
        throw new LedgerError(`"--verbose" does not accept a value.`);
      }
      parsed.verbose = true;
      continue;
    }

    const key = FLAGS[flag];

    if (key === undefined) {
      throw new LedgerError(`Unknown argument "${token}".`);
    }

    let value: string;

    if (eq === -1) {
      const next = argv[i + 1];

      if (next === undefined) {
        throw new LedgerError(`Missing value for "${flag}".`);
      }

      value = next;
      i += 1;
    } else {
      value = token.slice(eq + 1);
    }

    parsed[key] = value;
  }

  return parsed;
}
