---
"openwiki": patch
---

Gate OpenWiki connector tools by run mode. `createOpenWikiConnectorTools` now takes an `outputMode` and returns no connector tools for `repository` (code) mode, so code-mode agents are no longer offered credentialed external ingestion tools (Gmail, Slack, X, ...) that throw on missing credentials. Personal/local-wiki runs are unchanged. Fixes #444.
