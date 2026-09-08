---
"openwiki": patch
---

Accept MCP connector env vars that are explicitly set to an empty string. Previously a variable set to `""` was treated as missing and aborted ingestion with "<VAR> is required for MCP connector ingestion.".
