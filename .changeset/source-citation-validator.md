---
"openwiki": minor
---

Detect wiki source references invalidated by a file move. A finalize-pass validator resolves the repository paths each page cites in prose and stamps any whose file has moved with an inline `openwiki: stale source reference` comment naming the new location, so a later update run repairs the path. The new `openwiki doctor` command reports the same findings without writing, alongside the pages whose cited files changed since the commit the wiki last documented, and exits non-zero when a reference is stale. Both are deterministic and make no model calls.
