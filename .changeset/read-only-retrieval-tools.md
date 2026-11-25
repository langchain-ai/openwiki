---
"openwiki": patch
---

The MCP server marks the four retrieval tools (`openwiki_list_workspaces`, `openwiki_list_wikis`, `openwiki_search` and `openwiki_read`) with the `readOnlyHint` annotation, so hosts that gate tools without it, such as Claude Code in plan mode, run wiki search and read without a permission prompt. The generation lifecycle tools are unchanged.
