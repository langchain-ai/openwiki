import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ModelEvaluationBackend } from "./evaluator/model-backend.js";
import { parseArgs } from "./run/args.js";
import { loadBenchmark } from "./benchmark/benchmark.js";
import { OpenWikiSystem } from "./system/openwiki-system.js";
import { finalizeRun, persistFailureAudit } from "./run/finalize.js";
import {
  prepareRunDirectory,
  writeArtifactSnapshot,
  writeAssertionInventory,
  writeEvidenceCorpus,
} from "./run/persistence.js";
import { createCliProgressReporter } from "./run/progress.js";
import { resolveRunConfig } from "./run/run-config.js";
import { runBenchmark } from "./run/runner.js";

/**
 * Absolute path to the directory this module lives in (`evals/ledger`).
 */
const evalDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve config, run the benchmark, persist the result and report, and print a
 * summary. The start timestamp is stamped here (the one place a wall-clock read
 * is appropriate) and threaded into the runner so the run result is otherwise a
 * pure function of its inputs.
 *
 * @returns Nothing; side effects are the written files and printed report.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveRunConfig(args, process.env, evalDir);
  const benchmark = await loadBenchmark(config.benchmarkDir);
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const runDir = await prepareRunDirectory(
    config.resultsDir,
    benchmark.name,
    startedAt,
  );

  const system = new OpenWikiSystem({
    provider: config.provider,
    modelId: config.systemModelId,
  });
  const evaluationBackend = new ModelEvaluationBackend({
    provider: config.provider,
    // resolveRunConfig guarantees a concrete evaluator model id.
    modelId: config.evaluatorModelId as string,
    onAssertionInventory: (inventory) =>
      writeAssertionInventory(runDir, inventory),
  });

  let result;

  try {
    result = await runBenchmark({
      benchmark,
      system,
      evaluationBackend,
      config,
      startedAt,
      onArtifact: (artifact) => writeArtifactSnapshot(runDir, artifact),
      onEvidence: (evidence) => writeEvidenceCorpus(runDir, evidence),
      onProgress: createCliProgressReporter(process.stderr, {
        verbose: args.verbose === true,
      }),
    });
  } catch (error) {
    await persistFailureAudit(runDir, error);
    throw error;
  }

  await finalizeRun({
    resultsDir: config.resultsDir,
    runDir,
    result,
    startedMs,
  });
}

// Direct-invocation guard: run only when executed as a script, not when imported
// by a test.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
