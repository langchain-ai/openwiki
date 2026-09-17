---
"openwiki": minor
---

feat: add Ollama as a web search and web fetch provider for the web-search connector

Set `"provider": "ollama"` in the connector config to search via Ollama's `web_search` API (`OLLAMA_API_KEY`), and optionally fetch configured page URLs with Ollama's `web_fetch` API. Tavily remains the default provider.
