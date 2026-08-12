import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadBenchmark } from "./benchmark/benchmark.js";
import { ModelEvaluationBackend } from "./evaluator/model-backend.js";
import { finalizeRun, persistFailureAudit } from "./run/finalize.js";
import {
  prepareRunDirectory,
  writeArtifactSnapshot,
  writeAssertionInventory,
  writeEvidenceCorpus,
} from "./run/persistence.js";
import { createCliProgressReporter } from "./run/progress.js";
import { reevaluateSavedRun } from "./run/reevaluator.js";
import { resolveReevaluationConfig } from "./run/reevaluate-args.js";

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
  // Source is now the ground truth: surface extraction and grounding both read
  // the repository at each checkpoint's commit, so the working tree must exist
  // even for a pure re-evaluation of a saved run.
  const benchmark = await loadBenchmark(config.benchmarkDir);
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
      onProgress: createCliProgressReporter(process.stderr, {
        verbose: config.verbose,
      }),
      onArtifact: (artifact) => writeArtifactSnapshot(runDir, artifact),
      onEvidence: (evidence) => writeEvidenceCorpus(runDir, evidence),
    });
    await finalizeRun({
      resultsDir: config.resultsDir,
      runDir,
      result,
      startedMs,
    });
  } catch (error) {
    await persistFailureAudit(runDir, error);
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
