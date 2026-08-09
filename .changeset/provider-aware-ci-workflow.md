---
"openwiki": minor
---

Generate the scheduled-update workflow's provider block from the provider configured during setup instead of always emitting the OpenRouter one. The workflow now references the matching credential secret, any endpoint/project/region the provider requires, and the selected model ID, so a non-OpenRouter setup no longer has to hand-edit the file before its first scheduled run can authenticate.
