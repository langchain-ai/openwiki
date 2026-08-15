---
"openwiki": patch
---

claude-cli provider: recover when the model reports its tools are missing.

`claude -p` exposes no native tools, so this provider passes OpenWiki's toolset
in the prompt and reads tool calls back out of the structured reply. A model
that distrusts that framing answers with prose about the missing tools instead
of the calls that would have done the work — and because that prose is a
well-formed `kind:"text"` reply, the agent loop accepts it as a finished turn.
The run reports success having written nothing.

Such a reply is now retried once with a correction rather than taken at face
value.
