---
"openwiki": patch
---

Add `OPENWIKI_OPENAI_COMPATIBLE_MAX_TOKENS` so local OpenAI-compatible endpoints can cap per-request output tokens when omitted `max_tokens` values make near-limit prompts exceed the model context window.
