import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { LedgerRunResult } from "../core/types.js";
import {
  writeRunFailure,
  writeRunResult,
  writeUnverifiedClaims,
} from "./persistence.js";
import { formatReport } from "./report.js";
import { formatRunSummary } from "./summary.js";

/**
 * Persist bounded failure metadata for an incomplete run and report where the
 * audit artifacts landed, degrading to a stderr note if even that write fails so
 * the original error still propagates. Shared by every entry point's catch
 * handler.
 *
 * @param runDir - Prepared confined run directory.
 * @param error - The failure raised by benchmark execution.
 *
 * @returns Nothing after the failure audit is written or its failure is noted.
 */
export async function persistFailureAudit(
  runDir: string,
  error: unknown,
): Promise<void> {
  try {
    await writeRunFailure(runDir, error);
    process.stderr.write(`Audit artifacts written to ${runDir}\n`);
  } catch (persistenceError) {
    process.stderr.write(
      `Could not persist failure audit artifacts: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}\n`,
    );
  }
}

/**
 * Inputs for finalizing a completed run.
 */
export interface FinalizeRunInputs {
  /**
   * Absolute or relative results root the canonical `result.json` is written
   * beneath.
   */
  resultsDir: string;

  /**
   * Prepared confined run directory holding this run's audit artifacts.
   */
  runDir: string;

  /**
   * The completed run result to persist and summarize.
   */
  result: LedgerRunResult;

  /**
   * Monotonic `performance.now()` reading taken at run start, used to report
   * wall-clock elapsed time in the summary.
   */
  startedMs: number;
}

/**
 * Persist a completed run and print its human-readable summary: write the
 * canonical result JSON, the rendered report, and the unverified-claims worklist,
 * then emit the deliberately small run summary to stderr. Shared by every entry
 * point's success path.
 *
 * @param inputs - The finalization inputs.
 *
 * @returns Nothing after the result, report, worklist, and summary are durable.
 */
export async function finalizeRun(inputs: FinalizeRunInputs): Promise<void> {
  const { resultsDir, runDir, result, startedMs } = inputs;

  await writeRunResult(resultsDir, result);
  await writeFile(path.join(runDir, "report.md"), formatReport(result), "utf8");

  await writeUnverifiedClaims(runDir, result);
  process.stderr.write(
    formatRunSummary(result, {
      detailsPath: path.join(runDir, "report.md"),
      elapsedMs: performance.now() - startedMs,
    }),
  );
}
