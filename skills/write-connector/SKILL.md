---
name: write-connector
description: Add a new built-in OpenWiki source connector. Use when a user asks to create or implement an OpenWiki connector.
---

# Write An OpenWiki Connector

OpenWiki connectors are built-in TypeScript modules in the OSS repository. Do not create a plugin marketplace, dynamic connector package, or runtime-loaded untrusted connector. Add normal source files and tests.

## Prefer Custom MCP For Arbitrary Servers

If the knowledge source already exposes a read-only MCP server (HTTP or stdio), use the built-in `custom-mcp` connector instead of adding a new ConnectorId:

- Configure `~/.openwiki/connectors/custom-mcp/config.json` with `enabled`, `transport`, optional `allowedTools`, and optional `readOnlyOperations`.
- Put secrets in `~/.openwiki/.env` and reference them as `${ENV_NAME}` in transport headers/env.
- Agent tools `openwiki_list_mcp_tools` / `openwiki_call_mcp_tool` accept `custom-mcp`.

Add a dedicated built-in connector only when you need provider-specific auth, scoping UI, or deterministic API pulls that MCP cannot express.

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
- For `custom-mcp`, users configure a reviewed built-in wrapper; still require allowedTools and/or MCP readOnlyHint before agentic tool calls (no mutating-tool heuristics beyond Notion's hosted endpoint).

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
