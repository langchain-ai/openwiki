---
"openwiki": minor
---

feat: add a resizable, collapsible graph panel to the visualizer

The graph and the reader now share a draggable splitter, and a topbar button
collapses the graph entirely so the reader can take the full width — both
persisted in `localStorage` across reloads. Fixes #658.

The splitter's hit area is intentionally wider than its visible line: a
near-miss press that lands on the graph canvas is read by force-graph as a
background click, which clears the currently open page. Pointer events on the
canvas are also suppressed for the duration of a drag as a second line of
defense.
