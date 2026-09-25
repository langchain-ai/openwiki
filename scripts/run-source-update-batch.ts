#!/usr/bin/env -S node --experimental-strip-types
/**
 * Subprocess entrypoint for one isolated wiki-update agent call, given an
 * arbitrary user message. Spawned as a fresh process for the same reason as
 * run-mesh-maintenance.ts: chaining agent calls back-to-back in one
 * long-lived process can fail with "terminated". Used by
 * src/wiki/pipeline.ts for enrichment, split, and merge operations, each of
 * which needs exactly this: one narrow agent call, isolated from whatever
 * else is running.
 *
 * Reads its input (cwd, modelId, userMessage) as JSON from the file at
 * argv[2], runs the update agent under the CLI's own telemetry wrapper, and
 * prints one JSON line to stdout on success.
 *
 * Usage: pnpm exec tsx scripts/run-source-update-batch.ts <input-json-path>
 */
import { readFile } from "node:fs/promises";

import { loadOpenWikiEnv } from "../src/config/env.js";
import {
  createOpenWikiThreadId,
  runOpenWikiAgent,
} from "../src/agent/index.js";
import type { OpenWikiRunOptions } from "../src/agent/types.js";
import {
  withRunTelemetry,
  type RunTelemetryContext,
} from "../src/telemetry/index.js";

type BatchInput = {
  cwd: string;
  modelId?: string | null;
  userMessage: string;
};

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: run-source-update-batch.ts <input-json-path>");
    process.exit(1);
  }

  const input = JSON.parse(await readFile(inputPath, "utf8")) as BatchInput;
  await loadOpenWikiEnv();

  const runOptions: OpenWikiRunOptions = {
    isFollowup: false,
    modelId: input.modelId ?? undefined,
    outputMode: "local-wiki",
    threadId: createOpenWikiThreadId(input.cwd),
    userMessage: input.userMessage,
  };
  const telemetryContext: RunTelemetryContext = {};

  await withRunTelemetry("update", runOptions, telemetryContext, () =>
    runOpenWikiAgent("update", input.cwd, runOptions, telemetryContext),
  );

  console.log(JSON.stringify({ status: "success" }));
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
