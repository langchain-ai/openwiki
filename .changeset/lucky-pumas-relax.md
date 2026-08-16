---
"openwiki": patch
---

Fix `openwiki --init` crashing with `Invalid response from "wrapModelCall" in middleware "patchToolCallsMiddleware"` when the openai-compatible provider targets an endpoint that streams reasoning deltas before the first assistant-role delta (e.g. z.ai GLM). OpenAI-compatible runs now stream with `updates` instead of `messages` mode by default; set `OPENWIKI_OPENAI_COMPATIBLE_STREAM_MESSAGES=true` to restore live token streaming on endpoints known to emit a role-bearing first delta.
