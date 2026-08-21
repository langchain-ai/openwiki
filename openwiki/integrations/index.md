# Files

- [Coding-agent integrations](coding-agents.md) - OpenWiki's coding-agent integration system installs a skill bundle and stdio MCP server into Codex and Claude Code, exposing a begin/inspect_claims/resolve_claims/finish lifecycle protocol so external coding agents can author repository wikis with the same Grounded Claims discipline as the native CLI agent.
- [OpenWiki Connectors](connectors.md) - OpenWiki's nine built-in connectors ingest data from Git repositories, Gmail, Hacker News, LangSmith, Notion, a generic Custom MCP source, Slack, web search, and X into a local raw cache for wiki synthesis. This reference documents connector architecture, read-only MCP safeguards, ingestion orchestration, and source-specific behavior.
