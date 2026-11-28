---
"openwiki": patch
---

Coding-agent integrations are told to write page-relative internal wiki links. The skill and MCP instructions now carry the same rule as OpenWiki's own page workers, so a host no longer writes page paths such as `/openwiki/okf/sync.md` as link hrefs that the link validator then flags as broken.
