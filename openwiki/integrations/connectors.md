---
type: Integration
title: Citations
description: OpenWiki ships seven built-in connectors that pull external data
  into a local raw cache under `~/.openwiki/connectors/<id>/raw/`, which the
  documentation agent then reads and synthesizes into wiki ...
timestamp: 2026-07-10T21:04:04.976Z
---

OpenWiki ships seven built-in connectors that pull external data into a local raw cache under `~/.openwiki/connectors/<id>/raw/`, which the documentation agent then reads and synthesizes into wiki pages (mainly for personal/local-wiki mode; `git-repo` also matters for code mode when documenting a different target repo than the one being ingested from).

## Connector architecture

All connectors share types in `src/connectors/types.ts`:

- `ConnectorId` — the union of implemented connector ids: `"git-repo" | "google" | "hackernews" | "notion" | "slack" | "web-search" | "x"`. This union is ground truth for what exists today.
- `ConnectorBackend` — `"direct-api" | "local-git" | "mcp-http" | "mcp-stdio"`.
- `ConnectorDefinition` / `ConnectorRuntime` — id, display name, description, required env var names, whether the connector supports agentic discovery (letting the agent decide what to fetch) vs. deterministic ingestion, and an `ingest()` function.
- `ConnectorIngestResult` — `{ status: "success" | "skipped" | "error", rawFiles, warnings, runId, statePath, message }`.
- `ConnectorState` — per-connector cursor/dedup bookkeeping (`lastRunAt`, `latestIds`, last 20 `runs`) persisted at `~/.openwiki/connectors/<id>/state.json`.

`src/connectors/registry.ts` (`createConnectorRegistry()`) wires up all seven; `notion` is built through the generic `createMcpConnector()` factory (`src/connectors/sources/mcp.ts`) rather than a bespoke source file.

Shared IO helpers live in `src/connectors/io.ts`: `writeRawJson()` writes raw dumps with `0600`/`0700` permissions under `~/.openwiki/connectors/<id>/raw/<runId>/`, and `updateStateWithRun()` maintains the state file.

Agent-facing tools (`src/connectors/tools.ts`) expose this to the LLM during a run: `openwiki_list_connectors`, `openwiki_list_mcp_tools`, `openwiki_call_mcp_tool`, `openwiki_ingest_connector`, `openwiki_ingest_all_connectors`, `openwiki_list_raw_items`, `openwiki_read_raw_item`. Raw-file reads are sandboxed to stay inside each connector's `raw/` directory, and required-env status is reported as booleans only — secret values are never surfaced to the model.

## MCP subsystem

`src/connectors/mcp-client.ts` is a low-level JSON-RPC MCP client (stdio or HTTP transport) implementing `listMcpTools`/`executeMcpTool`/`executeMcpReadOnlyOperations`. `src/connectors/mcp-runtime.ts` wraps it for connector use (currently only `notion`), adding a **read-only tool-call policy**: a tool call is allowed only if it's explicitly listed in `allowedTools`, the MCP server's own `readOnlyHint` annotation is `true`, or (for the hosted `mcp.notion.com/mcp` endpoint specifically) the tool name/description matches a read-only heuristic (search/retrieve/get/list/query/read/fetch/find/lookup/load/children). This is the mechanism that keeps MCP-backed connectors read-only even though the underlying server may expose write tools.

## The seven connectors

| Connector        | Backend                        | Required env                                             | Agentic discovery | What it pulls                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------ | -------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git-repo`       | local-git                      | none                                                     | yes               | Local repos configured in connector config (`repos: [{id, path}]`): branch/HEAD, `git log` (last 20, name-status), `git status --short`, `git diff --name-status HEAD`. Writes `manifest.json`.                                                                           |
| `google` (Gmail) | direct-api                     | Gmail OAuth access/refresh token env keys                | no                | Gmail API v1 messages; default query `newer_than:1d`, configurable label/format/headers. Writes `gmail-messages.json`.                                                                                                                                                    |
| `hackernews`     | direct-api                     | none                                                     | no                | Public HN Firebase feeds (`top`/`new`/`best`/`show`/`ask`/`job`) plus Algolia `search_by_date` queries. Writes `hackernews-results.json`.                                                                                                                                 |
| `notion`         | mcp-stdio (label; may be HTTP) | `OPENWIKI_NOTION_MCP_ACCESS_TOKEN`                       | yes               | Hosted Notion MCP server (or configured MCP transport); discovers tools (`mcp-tools.json`) or executes configured read-only operations (`mcp-results.json`).                                                                                                              |
| `slack`          | direct-api                     | Slack user-token env key                                 | no                | `auth.test` identity, `search.messages` self-message search, bounded `conversations.list`/`.history` fallback, `assistant.search.context`. Writes `identity.json`, `my-messages-search.json`, `recent-messages.json`, `my-recent-messages.json`, `assistant-search.json`. |
| `web-search`     | direct-api                     | `TAVILY_API_KEY` (via `OPENWIKI_TAVILY_API_KEY_ENV_KEY`) | no                | Tavily search (`@langchain/tavily`) for configured queries. Writes `web-search-results.json`.                                                                                                                                                                             |
| `x`              | direct-api                     | X OAuth user-context access token env key                | no                | X API v2: `home_timeline`, `user_posts`, `mentions`, `bookmarks`, `list_posts` streams, paginated with per-stream `since_id` cursors (bookmarks always re-pulled). Writes one JSON file per stream/list.                                                                  |

### Notable per-connector behavior

- **Slack and "latest message" questions**: `my-recent-messages.json` includes a `definitiveForLatestMessage` flag. It is `true` only when the latest message was resolved via `search.messages` (requires the `search:read` user-token scope). If that search is unavailable, the connector falls back to a bounded `conversations.history` scan, sets `definitiveForLatestMessage: false`, and warns that the result is not reliably the user's true latest Slack message. Always check this flag before answering "what did I last say on Slack" from raw Slack data.
- **X streams and cursors**: each stream (except `bookmarks`) tracks a `since_id` cursor in connector state so repeated ingestion runs are incremental; `list_posts` fans out per configured `listIds`.
- **Notion is disabled until configured**: `enabled: true` plus a transport must be set in connector config before ingestion does anything beyond tool discovery.
- **git-repo has no ingest-vs-agent distinction for read access**: it's the only connector marked `supportsAgenticDiscovery: true` alongside `notion`, since a git checkout can be explored freely rather than pulled through a bounded API.

## Ingestion orchestration

`src/ingestion.ts` (`runOpenWikiIngestion`) loads `~/.openwiki/.env`, reads onboarding config, builds the connector registry, and resolves a target — `"all"`, a bare `ConnectorId`, or a specific source instance id (connectors can be configured more than once, e.g. `web-search-1`/`web-search-2`, run individually via `openwiki ingest web-search-2`). For each matched instance it runs deterministic ingestion first (writing raw JSON + updating state), then the synthesis agent run reads those raw files to update the wiki. This split — deterministic fetch, then LLM synthesis — keeps credentialed network calls out of model-controlled code paths.

## Onboarding and scheduling

`src/onboarding.ts` drives first-run setup: wiki template selection, scope customization, per-source ingestion notes, and source schedules, persisted to `~/.openwiki/onboarding.json`. Global personal-wiki instructions are saved to `~/.openwiki/INSTRUCTIONS.md`.

`src/schedules.ts` installs source schedules as macOS user LaunchAgents (`~/Library/LaunchAgents/`) with logs under `~/.openwiki/logs/`, and backs the `openwiki cron list|pause|resume|delete` commands (see [CLI usage](/cli/usage.md)).

## Design docs describing connectors that do not exist yet

Two long-form guides at the repository root describe **planned, unimplemented** connectors — do not treat them as current behavior:

- `LANGSMITH-CONNECTOR.md` — a proposed `langsmith` connector (direct-API pull of LangSmith run telemetry: error patterns, latency/token stats, trace URLs). No `langsmith` id exists in `src/connectors/types.ts` today.
- `CODING-AGENTS-CONNECTOR.md` — a proposed `coding-agents` connector (parses local Claude Code/Codex session logs for episodic "why did this commit happen" context). Depends on the LangSmith guide's shared `src/connectors/limits.ts`, which also does not exist yet.

If asked to implement either, follow the guide's phased checkpoints and confirm current state against `src/connectors/types.ts` first — these are detailed enough to be mistaken for documentation of shipped features.

## Things to watch when changing connector behavior

- Adding a connector means: extend `ConnectorId` in `types.ts`, add a source file under `src/connectors/sources/`, register it in `registry.ts`, and add its `SOURCE_OPTIONS` entry in `src/credentials.tsx` onboarding — see `~/.openwiki/skills/write-connector.md` (written on demand by `src/connectors/write-connector-skill.ts`) for the full checklist.
- Never write secret values into connector config or raw dumps — only env var names and presence booleans.
- Keep deterministic ingestion (network calls) out of agent-controlled code; the agent only reads what ingestion already wrote to `raw/`.
- MCP connectors must stay read-only; changes to `mcp-runtime.ts`'s tool-call policy directly affect what a hosted MCP server is allowed to do on OpenWiki's behalf.

# Citations

- `src/connectors/types.ts`, `src/connectors/registry.ts`, `src/connectors/io.ts`, `src/connectors/tools.ts`
- `src/connectors/mcp-client.ts`, `src/connectors/mcp-runtime.ts`, `src/connectors/sources/mcp.ts`
- `src/connectors/sources/git-repo.ts`, `src/connectors/sources/gmail.ts`, `src/connectors/sources/hackernews.ts`, `src/connectors/sources/slack.ts`, `src/connectors/sources/web-search.ts`, `src/connectors/sources/x.ts`
- `src/ingestion.ts`, `src/onboarding.ts`, `src/schedules.ts`
- `LANGSMITH-CONNECTOR.md`, `CODING-AGENTS-CONNECTOR.md`
- `test/onboarding.test.ts`
