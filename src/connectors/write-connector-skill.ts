import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureOpenWikiHome, openWikiSkillsDir } from "../openwiki-home.js";

export const writeConnectorSkillPath = path.join(
  openWikiSkillsDir,
  "write-connector.md",
);

export async function ensureWriteConnectorSkill(): Promise<void> {
  await ensureOpenWikiHome();

  try {
    await readFile(writeConnectorSkillPath, "utf8");
    return;
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  await writeFile(
    writeConnectorSkillPath,
    `${WRITE_CONNECTOR_SKILL.trim()}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

const WRITE_CONNECTOR_SKILL = `
# Write An OpenWiki Connector

Use this skill when a user asks to add a new OpenWiki source connector.

OpenWiki connectors are built-in TypeScript modules in the OSS repository. Do not create a plugin marketplace, dynamic connector package, or runtime-loaded untrusted connector. Add normal source files and tests.

## Required Shape

- Add the connector to src/connectors/types.ts and src/connectors/registry.ts.
- Implement the connector under src/connectors/sources/<connector>.ts.
- The connector must expose a ConnectorRuntime with id, displayName, description, backend, requiredEnv, supportsAgenticDiscovery, and ingest().
- Ingestion writes raw JSON/manifests under ~/.openwiki/connectors/<id>/raw/<run-id>/.
- State lives in ~/.openwiki/connectors/<id>/state.json.
- Config lives in ~/.openwiki/connectors/<id>/config.json.
- Secrets live in ~/.openwiki/.env and are referenced only by env var name.

## Security Rules

- Never read, print, log, return, or hardcode secret values.
- Do not store credentials in connector config, raw files, state, logs, or tests.
- Validate connector IDs and raw file paths so reads and writes stay inside ~/.openwiki/connectors/<id>/.
- Use deterministic ingestion code for credentialed external fetching.
- If wrapping MCP, treat the MCP server as read-only and call only allowlisted read/dump operations from connector config.
- Do not let untrusted connector manifests instantiate arbitrary commands or arbitrary network endpoints without explicit built-in code review.

## Ingestion Rules

- Git/local repos should write compact manifests and let the agent inspect the local repo as the source of truth.
- Sources with timestamps should store per-stream cursors.
- Sources with object metadata should store IDs, last edited timestamps, and content hashes.
- Sources with pagination should store enough state to continue without refetching everything.
- Raw dumps should preserve source IDs, timestamps, URLs, authors, and enough provenance for citations.

## User-Facing Finish

When done, tell the user:

- which connector files changed,
- which env vars to set in ~/.openwiki/.env,
- what config file to create or edit,
- how to run openwiki personal --update to trigger ingestion,
- which scopes/permissions the source provider requires.
`;

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
