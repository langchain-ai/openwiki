---
"openwiki": minor
---

Support reasoning effort for the GPT-6 models on the ChatGPT login: `gpt-6-astra` and `gpt-6-sol` accept `ultra` alongside `low`, `medium`, `high`, `xhigh`, and `max`, and `gpt-6-luna` accepts the same levels without `ultra`. The per-model levels follow the Codex model catalog (https://developers.openai.com/codex/models), and the three IDs are set with `OPENWIKI_MODEL_ID` rather than the model picker, which gains the GPT-6 presets in a separate change.
