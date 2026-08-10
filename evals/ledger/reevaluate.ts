import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadBenchmark } from "./benchmark/benchmark.js";
import { ModelEvaluationBackend } from "./evaluator/model-backend.js";
import {
  prepareRunDirectory,
  writeArtifactSnapshot,
  writeAssertionInventory,
  writeEvidenceCorpus,
  writeRunFailure,
  writeRunResult,
  writeUnverifiedClaims,
} from "./run/persistence.js";
import { createCliProgressReporter } from "./run/progress.js";
import { reevaluateSavedRun } from "./run/reevaluator.js";
import { resolveReevaluationConfig } from "./run/reevaluate-args.js";
import { formatReport } from "./run/report.js";
import { formatRunSummary } from "./run/summary.js";

/**
 * Absolute directory containing the LEDGER implementation.
 */
const evalDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Re-evaluate one completed LEDGER run without invoking the System Under Test,
 * then persist a fully auditable independent result.
 *
 * @returns Nothing after the new result and report are durable.
 */
async function main(): Promise<void> {
  const config = resolveReevaluationConfig(
    process.argv.slice(2),
    process.env,
    evalDir,
  );
  const benchmark = await loadBenchmark(config.benchmarkDir, {
    ensureSourceRepo: false,
  });
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const runDir = await prepareRunDirectory(
    config.resultsDir,
    benchmark.name,
    startedAt,
  );
  const evaluationBackend = new ModelEvaluationBackend({
    provider: config.provider,
    modelId: config.evaluatorModelId,
    onAssertionInventory: (inventory) =>
      writeAssertionInventory(runDir, inventory),
  });

  try {
    const result = await reevaluateSavedRun({
      benchmark,
      sourceRunDir: config.sourceRunDir,
      evaluationBackend,
      provider: config.provider,
      evaluatorModelId: config.evaluatorModelId,
      startedAt,
      onProgress: createCliProgressReporter(),
      onArtifact: (artifact) => writeArtifactSnapshot(runDir, artifact),
      onEvidence: (evidence) => writeEvidenceCorpus(runDir, evidence),
    });
    await writeRunResult(config.resultsDir, result);
    await writeFile(
      path.join(runDir, "report.md"),
      formatReport(result),
      "utf8",
    );

    const unverifiedClaimsPath = await writeUnverifiedClaims(runDir, result);
    process.stderr.write(
      formatRunSummary(result, {
        unverifiedClaimsPath,
        elapsedMs: performance.now() - startedMs,
      }),
    );
    process.stderr.write(`📁 Results · ${runDir}\n`);
  } catch (error) {
    try {
      await writeRunFailure(runDir, error);
      process.stderr.write(`Audit artifacts written to ${runDir}\n`);
    } catch (persistenceError) {
      process.stderr.write(
        `Could not persist failure audit artifacts: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}\n`,
      );
    }

    throw error;
  }
}

// Direct-invocation guard: run only when executed as a script, not when imported
// by a test.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
