# OpenWiki authoring methodology

## Contents

- [Authority and evidence](#authority-and-evidence)
- [Output language](#output-language)
- [Page design](#page-design)
- [OKF frontmatter](#okf-frontmatter)
- [Relationships](#relationships)
- [Source maps and testing](#source-maps-and-testing)
- [Diagrams](#diagrams)

## Authority and evidence

Treat source code and tests as authoritative. Use existing documentation as
context, then verify material facts against implementation. State genuine
unknowns narrowly instead of inferring behavior.

## Output language

Write factual prose in the `language` returned by `openwiki_begin`. Preserve
code identifiers, paths, commands, API names, URLs, and code blocks when
translation would reduce technical accuracy. On an explicit language switch,
translate every factual page consistently in the same update.

## Page design

Organize around systems, concepts, workflows, and operations rather than folders.
Explain responsibility, boundaries, runtime behavior, important data or
configuration, failure behavior, and where to make a change.

## OKF frontmatter

Begin each factual concept page with YAML frontmatter:

```yaml
---
type: Architecture Guide
title: Authentication runtime
description: Explains session creation, token persistence, and request authentication boundaries.
tags: [authentication, sessions]
---
```

`type` is required. Preserve unknown producer fields. Do not author `generated`;
OpenWiki stamps it during finish. Do not add concept frontmatter to generated
indexes or logs.

## Relationships

Put links in sentences that explain relationships such as “dispatches to,”
“depends on,” “shares infrastructure with,” or “is configured through.” Do not
rely on indexes or tags alone.

## Source maps and testing

Name primary files and symbols in prose or a focused source map. Connect behavior
to representative tests and the narrowest useful validation command. Avoid
exhaustive inventories.

## Diagrams

Use Mermaid sequence diagrams for runtime flows, state diagrams for lifecycles,
flowcharts for meaningful branching, and ER diagrams for data models. Ground
every participant, state, and edge in inspected source.
