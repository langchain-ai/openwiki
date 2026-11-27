---
"openwiki": patch
---

Treat MCP tool results marked `isError` as failed operations during MCP connector ingestion. Failed calls are reported as warnings and left out of the raw dump, and a pull where every operation failed is now reported as an error instead of a successful ingestion that hands error text to the wiki update.
