---
"openwiki": patch
---

Add `OPENWIKI_REQUEST_TIMEOUT` to raise the OpenAI client's 10-minute request timeout, so long planning streams from slow self-hosted `openai-compatible` backends aren't cut off.
