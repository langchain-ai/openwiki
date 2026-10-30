#!/usr/bin/env -S node --experimental-strip-types
/**
 * Subprocess entrypoint for the deterministic mesh-maintenance pipeline
 * (src/wiki/pipeline.ts). Spawned as a fresh process by `openwiki ingest`
 * (src/ingestion/ingestion.ts) rather than called in-process: chaining it
 * after the ingestion agent's own LLM calls in one long-lived process can
 * fail with "terminated".
 *
 * Prints one JSON line (the MeshMaintenanceReport) to stdout on success.
 *
 * Usage: pnpm exec tsx scripts/run-mesh-maintenance.ts <connectorId>
 */
import { loadOpenWikiEnv } from "../src/config/env.js";
import { openWikiLocalWikiDir } from "../src/config/openwiki-home.js";
import { runMeshMaintenance } from "../src/wiki/pipeline.js";

async function main(): Promise<void> {
  const connectorId = process.argv[2];
  if (!connectorId) {
    console.error("Usage: run-mesh-maintenance.ts <connectorId>");
    process.exit(1);
  }

  await loadOpenWikiEnv();
  const report = await runMeshMaintenance(connectorId, openWikiLocalWikiDir);
  console.log(JSON.stringify(report));
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
