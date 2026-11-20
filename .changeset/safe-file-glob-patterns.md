---
"openwiki": patch
---

Reject parenthesized glob patterns and grep file filters to prevent an unpatched picomatch denial of service. Use simple wildcards or separate searches instead; literal grep queries are unchanged.
