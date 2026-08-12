---
"openwiki": patch
---

feat: support OPENWIKI_CONFIG_DIR env var and display configurable paths

Add OPENWIKI_CONFIG_DIR to override the default ~/.openwiki state directory,
with tilde expansion for ~/ prefixed values. All user-facing messages and
tool result paths now show the resolved display path instead of a hardcoded
~/.openwiki, so CLI output and agent context stay accurate when the
directory is relocated.
