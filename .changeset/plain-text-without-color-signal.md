---
"openwiki": patch
---

Keep TUI text readable when the environment declares no color support (empty or unset `TERM`/`COLORTERM`). An exported-but-empty variable used to still select a color level, and gray secondary text could render as the same color as the terminal background. The CLI now renders plain text in that case.
