---
type: Reference
title: Connector Sources
description: Per-source built-in connectors — git-repo, custom-mcp/notion, X, Gmail, Slack, web search, and Hacker News — with their backends, required credentials, and ingestion behavior.
tags: [connectors, sources, mcp, ingestion, personal]
sources:
  - id: openwiki-source-56829dc66a31b64a36ed8745
    resource: repo://src/connectors/mcp-runtime.ts
  - id: openwiki-source-3632bcf6292cc01fef69c5b7
    resource: repo://src/connectors/registry.ts
  - id: openwiki-source-ebd2b316d3147e7fde3920a4
    resource: repo://src/connectors/sources/git-repo.ts
  - id: openwiki-source-0dd970ab1b5ab5ad763ca199
    resource: repo://src/connectors/sources/gmail.ts
  - id: openwiki-source-e5bd2d88cb8bc284faef6f2e
    resource: repo://src/connectors/sources/hackernews.ts
  - id: openwiki-source-208e19767098e36e721f4333
    resource: repo://src/connectors/sources/mcp.ts
  - id: openwiki-source-1f94cd80bf448efe6d61d3ea
    resource: repo://src/connectors/sources/slack.ts
  - id: openwiki-source-fb0f16602b9d0cfe87d3c43c
    resource: repo://src/connectors/sources/web-search.ts
  - id: openwiki-source-bdb4edab7b339f62867857bf
    resource: repo://src/connectors/sources/x.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-22T08:02:55.052Z" }
verified:
  - by: openwiki/0.3.3
    at: 2026-08-22T08:02:55.052Z
---

# Connector Sources

All built-in sources are **personal-mode** connectors that write raw JSON under the OpenWiki home. They share the [registry, ingest contract, and resilient HTTP](overview.md); this page covers each source's backend, credentials, and behavior. The LangSmith source is documented separately in [langsmith.md](langsmith.md).

## Local Git repositories (`git-repo`)

Backed by `local-git`: it shells out to `git` against locally cloned repositories listed in its config and writes a compact manifest per repo (branch, HEAD, changed files, recent commits, status) for the update agent. It requires no credentials and supports agentic discovery. With no repos configured it returns without work.

## MCP sources (`custom-mcp`, `notion`)

Both are built by the shared MCP connector factory over the `mcp-stdio` backend (though the transport can be HTTP or stdio via config). `custom-mcp` points OpenWiki at any read-only MCP server and requires no fixed env; `notion` requires a Notion MCP access token. When a connector is not enabled in its config it returns a `skipped` result telling the user to configure a transport. Ingestion runs the configured read-only operations after listing tools, and sanitizes the transport (stripping secrets) in raw output.

## X / Twitter (`x`)

`direct-api` connector that fetches user timelines, mentions, list posts, and bookmarks through X API v2 with OAuth user context. Requires an X access token.

## Google / Gmail (`google`)

`direct-api` connector that fetches recent Gmail messages via the Gmail API with OAuth user credentials, requiring both an access token and a refresh token. Because `fetchWithResilience` surfaces a 401 rather than retrying it, Gmail can trigger a token refresh on auth failure.

## Slack (`slack`)

`direct-api` connector that fetches conversations, recent messages, and assistant search context using a Slack user token.

## Web Search (`web-search`)

`direct-api` connector that fetches web-search results with Tavily through the LangChain Tavily integration, requiring a Tavily API key.

## Hacker News (`hackernews`)

`direct-api` connector that fetches Hacker News feeds and query results through the public Hacker News APIs. It requires no credentials.

| Connector    | Backend    | Required env                 | Agentic discovery |
| ------------ | ---------- | ---------------------------- | ----------------- |
| `git-repo`   | local-git  | none                         | yes               |
| `custom-mcp` | mcp-stdio  | none                         | yes               |
| `notion`     | mcp-stdio  | Notion MCP token             | yes               |
| `x`          | direct-api | X access token               | no                |
| `google`     | direct-api | Gmail access + refresh token | no                |
| `slack`      | direct-api | Slack user token             | no                |
| `web-search` | direct-api | Tavily API key               | no                |
| `hackernews` | direct-api | none                         | no                |
