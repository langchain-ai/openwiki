---
name: write-connector
description: Add a new built-in OpenWiki source connector. Use when a user asks to create or implement an OpenWiki connector.
---

# Write An OpenWiki Connector

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
