#!/usr/bin/env -S node --experimental-strip-types
/**
 * Deterministically clusters a connector's latest raw pull into `/themes.md`
 * rows, replacing the unreliable agent theme-discovery step. Works on any
 * connector's raw JSON shape via structural field-name scanning (see
 * src/wiki/theme-extraction.ts), not hardcoded to a specific schema. Run
 * after `openwiki ingest <connector>`, before scripts/maintain-wiki-graph.ts.
 *
 * Usage: pnpm exec tsx scripts/extract-themes.ts <connectorId> [--min-records N]
 */
import { openWikiLocalWikiDir } from "../src/config/openwiki-home.js";
import {
  clusterByBestField,
  findLatestRawPull,
  loadRawRecords,
  writeDeterministicThemes,
} from "../src/wiki/theme-extraction.js";

async function main(): Promise<void> {
  const connectorId = process.argv[2];
  if (!connectorId) {
    console.error("Usage: extract-themes.ts <connectorId> [--min-records N]");
    process.exit(1);
  }

  const minRecordsArg = process.argv.indexOf("--min-records");
  const minRecords =
    minRecordsArg !== -1 && process.argv[minRecordsArg + 1]
      ? Number(process.argv[minRecordsArg + 1])
      : 3;

  const rawDir = await findLatestRawPull(openWikiLocalWikiDir, connectorId);
  if (!rawDir) {
    console.error(
      `No raw pull found for ${connectorId} — run \`openwiki ingest ${connectorId}\` first.`,
    );
    process.exit(1);
  }
  console.log(`Reading latest raw pull: ${rawDir}`);

  const records = await loadRawRecords(rawDir);
  console.log(`Loaded ${records.length} record(s).`);

  const themes = clusterByBestField(records, { minRecords });
  if (themes.length === 0) {
    console.log(
      "\nNo reliable taxonomy field found (or none produced a reasonable clustering) — " +
        "writing nothing. This is expected for connectors with no category/type/label-shaped " +
        "field; the agent's own judgment is still the only theme source for those.",
    );
    return;
  }

  console.log(
    `\nClustered by "${themes[0].fieldName}" into ${themes.length} theme(s) (>= ${minRecords} records each):`,
  );
  for (const theme of themes) {
    console.log(
      `  - ${theme.themeKey}: ${theme.count} records (${theme.fieldName}="${theme.category}")`,
    );
  }

  const { themeCount } = await writeDeterministicThemes(
    openWikiLocalWikiDir,
    connectorId,
    themes,
  );
  console.log(
    `\nWrote ${themeCount} deterministic theme row(s) to /themes.md.`,
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
