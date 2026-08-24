---
type: Reference
title: LangSmith Connector
description: The code-mode LangSmith connector — committed .langsmith.json workspaces, allowlisted hosts and key env vars, incremental trace pulls, and fail-open per-workspace/project errors.
tags: [connectors, langsmith, code-mode, traces, security]
sources:
  - id: openwiki-source-ee78a05d040c0973bce1fd5b
    resource: repo://src/connectors/sources/langsmith/api.ts
  - id: openwiki-source-e322f3319b9736ea1a0793af
    resource: repo://src/connectors/sources/langsmith/index.ts
  - id: openwiki-source-9e541d09b8e52185141cdccb
    resource: repo://src/connectors/sources/langsmith/repo-config.ts
  - id: openwiki-source-fd64a623405ece9d3b0615f5
    resource: repo://src/connectors/sources/langsmith/runs.ts
  - id: openwiki-source-053e849654b42fbddfbcfd7e
    resource: repo://src/connectors/sources/langsmith/setup.ts
  - id: openwiki-source-c6189f89b3f67d0cbf87739f
    resource: repo://src/ingestion/ingestion.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-22T08:02:55.052Z" }
verified:
  - by: openwiki/0.3.3
    at: 2026-08-22T08:02:55.052Z
---

# LangSmith Connector

LangSmith is OpenWiki's only **code-mode** connector: it pulls recent LangSmith traces (tool calls, outcomes, latency) through the official LangSmith SDK to help document a codebase's runtime behavior. Unlike personal connectors, its configuration is **committed to the repository** so CI and every teammate document the same workspaces and projects.

## Configuration: `.langsmith.json`

The committed config lives at `openwiki/.langsmith.json` under the repository root and lists **workspaces**, each with an API-key env var name, a set of projects, and an optional region host. A LangSmith key is workspace- and region-bound, so cross-region documentation needs one entry per workspace — each naming its own key. The key value itself is never committed; only the env var **name** lives in the file.

## Security boundaries

Because a workspace's base URL receives the user's API key in an `Authorization` header, a committed config is a potential exfiltration/SSRF vector, so two allowlists are enforced at parse time and re-validated at the use boundary:

- **Host allowlist** — only the three official LangSmith hosts (US, EU, APAC) are accepted; any other `apiBaseUrl` is dropped and the default host is used.
- **Key env allowlist** — `apiKeyEnv` must match the OpenWiki LangSmith namespace pattern, so a malicious config cannot name an unrelated secret like `AWS_SECRET_ACCESS_KEY` and send it off-host.

## Ingestion behavior

Ingest is **code-mode only** and depends on a `repoRoot`:

- Called without a `repoRoot` (e.g. by the generic ingest-all tool) it skips cleanly rather than reaching for a HOME config it never has.
- With no configured workspaces it skips with a "not configured" message.
- The `windowHours` option is an ingestion floor derived from the last-update time; undefined means "no floor" and bootstraps the latest traces.

Failures are **fail-open**: a missing workspace key, a disallowed key env, or a per-project fetch error becomes a warning rather than a run failure, so one bad entry never blocks the others or the whole run.

## Setup wizard

The onboarding wizard edits workspaces in terms of a **region** (`us`/`eu`/`apac`) rather than a raw URL, mapping each to one of the allowlisted hosts. The US host is the connector default and is omitted from the file; EU and APAC hosts are written explicitly. Additional workspaces get numbered key env vars.
