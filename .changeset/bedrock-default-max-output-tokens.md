---
"openwiki": patch
---

fix: default Bedrock runs on modern Claude models to a 16,384-token output ceiling

The Bedrock Converse API caps output at 4,096 tokens when a request sends no
`inferenceConfig`, which truncated long pages mid-write and ended the run
cleanly, looking like a page-count limit. Bedrock runs on modern Claude models
now use the same 16,384-token ceiling as the direct Anthropic provider. Models
without a known-wide output window keep the provider default, and
`OPENWIKI_MAX_OUTPUT_TOKENS` still overrides both.
