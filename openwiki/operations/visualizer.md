---
type: Reference
title: Wiki Visualizer
description: The interactive wiki graph visualizer — building the page/link graph, the loopback live-reload server with SSE, the strict CSP, and the self-contained static export.
tags: [visualizer, graph, server, static-export, operations]
sources:
  - id: openwiki-source-d92f623adbf6b31c3542d58d
    resource: repo://src/visualize/graph.ts
  - id: openwiki-source-4d856d692c32be213c8c46b4
    resource: repo://src/visualize/server.ts
  - id: openwiki-source-3603986778b0b5f63cbdb37d
    resource: repo://src/visualize/static-export.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-22T08:02:55.052Z" }
verified:
  - by: openwiki/0.3.3
    at: 2026-08-22T08:02:55.052Z
---

# Wiki Visualizer

The visualizer renders a generated wiki as an interactive graph of pages and the internal links between them. It can run as a live local server or be exported as a self-contained static site.

## The graph

`buildGraph` turns the generated wiki into a `WikiGraph` of page **nodes** and internal-link **edges**. Each node's title and type come from front matter with fallbacks to the first heading or filename, and its id is the `.md`-less path relative to the wiki root.

## Live server

```mermaid
flowchart LR
    Wiki["wiki directory"] -->|"fs.watch (debounced)"| Server["visualizer server (127.0.0.1)"]
    Server -->|"buildGraph"| Graph["WikiGraph"]
    Server -->|"SSE"| Browser["browser client"]
    Browser -->|"reload on change"| Browser
```

_Loopback server with live reload._

The server binds **loopback-only** (`127.0.0.1`) and never exposes the wiki on the network. It retries a busy preferred port by incrementing across a bounded number of attempts. While running, it watches the wiki directory, debounces bursts of file changes into one rebuild, and pushes updates to connected browsers over **server-sent events** for live reload. The browser client is served as an external module under a strict Content-Security-Policy that pins CDN libraries by SRI and avoids `unsafe-inline` for scripts.

## Static export

The static export writes a self-contained directory (`index.html`, client assets, styles, and `graph.json`) whose client reads `graph.json` and opens **no** SSE connection, so it can be hosted anywhere without OpenWiki. Both the server and the static export load the same compiled browser assets that ship beside the module in `dist/`.

The `visualize` CLI runner selects between serving and exporting; see [cli/runners.md](../cli/runners.md).
