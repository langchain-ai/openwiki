---
"openwiki": minor
---

feat: add a `claude-code` provider that routes inference through the local Claude Code CLI

Adds a keyless inference provider for users who cannot provision an Anthropic API key — notably Claude Team and Enterprise members whose plan does not grant API key creation. Selecting `Claude Code (local CLI)` during `openwiki --init` reuses the existing `claude auth login` session; OpenWiki never reads or persists a token.

Claude Code ships its own agent loop, so the bridge constrains it to a single model turn: OpenWiki's DeepAgents tools are exposed through an in-process MCP server, Claude Code's built-in tools are disabled, and `canUseTool` captures the resulting tool call and hands it back to the OpenWiki agent loop for execution. This keeps the virtual filesystem backend, OKF middleware, and translation middleware in control of the run.
