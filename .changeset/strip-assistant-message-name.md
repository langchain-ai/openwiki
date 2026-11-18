---
"openwiki": patch
---

The Mistral and OpenAI-compatible providers no longer send `name` on replayed assistant messages, so strict gateways such as Mistral stop rejecting runs with HTTP 422 `extra_forbidden` once the planning subagent has run.
