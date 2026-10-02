---
"openwiki": patch
---

Preserve compact YAML lists in front matter when rewriting a field, so pages using the unindented `- ` sequence form (what PyYAML emits by default) keep their `type`, `title` and custom fields instead of being reset to generated minimal metadata.
