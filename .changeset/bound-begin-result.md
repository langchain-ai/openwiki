---
"openwiki": patch
---

Cap the changed paths and Claims issues in the `openwiki_begin` result, with exact totals and truncated flags, so an update with a lot of drift no longer sends MCP hosts well over 100k characters.
