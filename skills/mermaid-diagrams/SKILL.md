---
name: mermaid-diagrams
description: Embed Mermaid diagrams in generated wiki pages. Use whenever documenting a runtime or request flow, a call sequence, a state machine or lifecycle, a data model or entity relationships, or non-trivial control flow, since these are clearer as a diagram than as prose. Also use when an update run touches a page that already contains a mermaid fence, or a page that contains a text fence a previous run degraded.
---

# Mermaid Diagrams In Generated Wiki Pages

Diagrams are part of high-quality wiki generation, not decoration. Where a flow,
lifecycle, or data model is easier to grasp visually, embed a Mermaid diagram in
a fenced ```mermaid block on the most relevant page.

## Choosing a diagram type

- `sequenceDiagram` for runtime and request flows across components (auth flows, request lifecycles, agent tool loops).
- `stateDiagram-v2` for lifecycles and state machines (job states, connection states, run phases).
- `erDiagram` for the data model: entities and their relationships.
- `flowchart TD` for branching control flow and decision logic.

## Discipline

- Ground every diagram in inspected source. Do not invent participants, states, entities, or relationships the code does not support.
- Cover the high-value cases: add a diagram wherever a page documents a request or runtime flow, a call sequence, a lifecycle or state machine, or a data model. A repository wiki usually has several such diagrams, not one overall. Skip pages that are navigation, reference tables, or pure configuration.
- Still prefer a few strong diagrams over decorating every page: one accurate diagram on the page that needs it beats a diagram forced onto every page.
- Give each diagram a one-line caption directly below it stating what it shows.
- OpenWiki validates every mermaid fence after your run and converts fences that fail to parse into plain text fences. A degraded diagram is a quality failure; follow the syntax rules below so it does not happen.

## Syntax safety

These rules prevent the most common render breakages. When in doubt, rephrase the label.

- Never place semicolons or pipes inside node, message, or edge labels.
- Never place unescaped angle brackets in labels; write "returns Promise of User" instead of "returns Promise<User>".
- In `flowchart`, wrap any label containing parentheses, brackets, or other punctuation in double quotes: `A["calls foo(bar)"]`.
- In `flowchart`, never use the bare word `end` as a node id, and never start a node id with `o` or `x` followed by a dash (both are edge-marker syntax); rename the node.
- In `sequenceDiagram`, participant names with spaces or punctuation need an alias: `participant AS as Auth Service`.
- Never use a Mermaid reserved word as a participant name, alias, or node id: `note`, `end`, `loop`, `alt`, `opt`, `par`, `and`, `else`, `activate`, `deactivate`, `class`, `state`, `click`, `link`. For example a notification participant must be `Notifier`, not `Note` (which collides with the `note` keyword).
- In `erDiagram`, entity and attribute names must be single identifier-like tokens; put human phrasing in the relationship label.
- Keep labels short. Move explanation into the surrounding prose or the caption, not the diagram.

## Update runs

- A wrong diagram is a stale claim, not existing structure to preserve. If a source change makes a diagram inaccurate, update the diagram in the same edit as the surrounding prose.
- Do not rewrite a diagram that is still accurate. Regenerating unchanged diagrams creates diff noise.
- If a page contains a text fence preceded by an HTML comment starting with "openwiki: mermaid parse failed", that is a diagram a previous run degraded. Fix the syntax using the parser error in the comment, restore the ```mermaid fence, and delete the comment.
