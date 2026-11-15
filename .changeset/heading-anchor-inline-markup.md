---
"openwiki": patch
---

Build internal-link heading anchors from the heading's rendered text, so links to headings that contain a link, `_` emphasis, or inline HTML (e.g. `#createagent` for ``## [`createAgent`](../src/agent.ts)``) are no longer stamped as broken.
