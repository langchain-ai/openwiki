---
"openwiki": patch
---

fix: stream Anthropic (direct and Vertex) requests so `OPENWIKI_MAX_OUTPUT_TOKENS` can go above ~21,333 tokens without the Anthropic SDK rejecting them as "Streaming is required for operations that may take longer than 10 minutes"
