---
"openwiki": patch
---

Skip update runs whose only worktree changes are OpenWiki's own generated files. An uncommitted `openwiki/` directory used to count as a repository change, so `openwiki --update` and `openwiki_begin` re-ran the full agent on every invocation instead of reporting a no-op.
