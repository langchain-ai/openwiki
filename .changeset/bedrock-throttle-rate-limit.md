---
"openwiki": patch
---

Recognize Bedrock throttling (`ThrottlingException`, including "Too many tokens, please wait before trying again.") as a provider rate limit during repository generation. A throttled page worker now lowers page concurrency and is not retried straight into the same quota, matching how HTTP 429 from other providers is handled.
