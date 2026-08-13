---
"openwiki": patch
---

fix: follow `nextCursor` when listing MCP tools, so tools on a paginated server past the first page are discovered and callable instead of rejected as "not returned by tools/list"
