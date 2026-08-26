---
type: integration
title: Interactive Visualizer
description: How the `openwiki visualize` command builds a link graph from wiki Markdown and OKF frontmatter, serves a live single-page reader over loopback HTTP, and exports a self-contained static site for hosting.
tags: [visualizer, graph, static-export, cli, server, markdown-reader]
sources:
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-d9796193ef2a63134f9c6e25
    resource: repo://scripts/copy-visualize-assets.cjs
  - id: openwiki-source-3fc16f0371ced4d94330f06c
    resource: repo://src/cli/commands.ts
  - id: openwiki-source-106c72a9cb6dd904077fc747
    resource: repo://src/cli/runners.ts
  - id: openwiki-source-ece93fbb8cb5e37f8a4eb963
    resource: repo://src/visualize/client-lib.ts
  - id: openwiki-source-610ff51ff8da46ab065496a5
    resource: repo://src/visualize/client.ts
  - id: openwiki-source-d92f623adbf6b31c3542d58d
    resource: repo://src/visualize/graph.ts
  - id: openwiki-source-b0d5ccee7e5f7532bd8ed3f5
    resource: repo://src/visualize/page.ts
  - id: openwiki-source-4d856d692c32be213c8c46b4
    resource: repo://src/visualize/server.ts
  - id: openwiki-source-3603986778b0b5f63cbdb37d
    resource: repo://src/visualize/static-export.ts
  - id: openwiki-source-e3be493bc871948f42420690
    resource: repo://test/visualize/client-interaction.test.ts
  - id: openwiki-source-1904eaebd82125a3a3881dac
    resource: repo://test/visualize/page.test.ts
  - id: openwiki-source-6b177c090fb1c7574a23496e
    resource: repo://test/visualize/server.test.ts
  - id: openwiki-source-2e48ab40ab957bcc05e92de0
    resource: repo://test/visualize/static-export.test.ts
  - id: openwiki-source-527000b93bb371d57e38ce6d
    resource: repo://test/visualize/visualize-client-lib.test.ts
  - id: openwiki-source-42403648c3f500ce06398039
    resource: repo://tsconfig.client.json
generated: { by: "openwiki/0.4.0", at: "2026-08-26T22:32:29.466Z" }
verified:
  - by: openwiki/0.4.0
    at: 2026-08-26T22:32:29.466Z
---

# Interactive Visualizer

The visualizer turns a generated wiki directory into an explorable node graph
paired with a Markdown reader. It runs in two modes from a single command,
`openwiki visualize`: a **live local server** that reflects edits in the browser
as you save, and a **static export** that writes a deployable folder you can host
anywhere. Both modes render the same branded single-page app; they differ only in
where the graph data comes from and whether live reload is wired.

## Command surface

`openwiki visualize [path] [--port <port>] [--no-open] [--export <dir>]` is parsed
in `src/cli/commands.ts`. The positional `path` defaults to `openwiki`, `--port`
defaults to `4321` (validated to the range 1024–65535), and the browser is opened
automatically unless `--no-open` is passed. Passing `--export <dir>` switches to
static-export mode; the parser rejects combining `--export` with `--port` or
`--no-open` because those flags only affect the live server.

`runVisualizeCommand` in `src/cli/runners.ts` dispatches on the parsed command:
when `exportDir` is set it calls `exportStaticVisualizer` and prints a summary,
otherwise it calls `runVisualizeServer`. Both wiki paths are resolved against the
current working directory before use.

## Building the graph

`buildGraph(wikiRoot)` in `src/visualize/graph.ts` is the shared data source for
both modes. It recursively collects `.md` files under the wiki root, reads each
into a node, resolves inter-page links into directed edges, and returns a
`WikiGraph` with a `root` basename, an ISO `generatedAt` timestamp, the sorted set
of distinct node `types`, and the `nodes`/`edges` arrays.

Each file becomes one `WikiNode`. Its stable `id` is the path relative to the wiki
root with the `.md` suffix removed. `splitFrontmatter` parses the small YAML subset
OpenWiki emits (scalars, inline `[a, b]` arrays, and dashed lists), and the known
OKF fields — `type`, `title`, `description`, `tags` — populate the node. When a
field is absent the node falls back deterministically: the title resolves from
frontmatter, then the section name for `index.md` pages or the first H1 otherwise,
then the filename; the type defaults to `Section` for `index.md` pages and
`Reference` for everything else. Node `size` is the body length in characters,
which the client uses to scale each node's radius.

Edges come from Markdown links. `linkNodes` scans each body for relative `.md`
link targets, resolves them against the linking page's directory into node ids,
and records a directed edge plus the reciprocal `backlinks` entry. Self-links,
links to pages not in the graph, and duplicate edges are dropped, so the graph
only ever contains resolvable page-to-page references. The walk stays inside the
wiki: paths that resolve outside `wikiRoot` are skipped, symlinks (which are
neither files nor directories to the dirent check) are never followed, and the
scaffolding files `INSTRUCTIONS.md` and `log.md` are excluded.

```mermaid
flowchart TD
  A["buildGraph(wikiRoot)"] --> B["collectMarkdown: recurse, skip excluded and out-of-root"]
  B --> C["readNode: splitFrontmatter, resolve title and type, measure size"]
  C --> D["linkNodes: resolve relative .md links to node ids"]
  D --> E["drop self-links, unknown targets, duplicates"]
  E --> F["record edges plus reciprocal backlinks"]
  F --> G["WikiGraph: root, generatedAt, types, nodes, edges"]
```

Graph construction from wiki files and OKF frontmatter to the serialized graph.

## Live server

`runVisualizeServer` in `src/visualize/server.ts` binds an HTTP server to the
loopback address `127.0.0.1` only, so the wiki is never exposed on the network. It
tries the preferred port and increments on `EADDRINUSE` for up to 20 attempts
before giving up. On startup it verifies the wiki directory exists, loads the
compiled browser assets once, performs an initial `buildGraph`, then begins a
recursive filesystem watch and prints a banner.

The request router built by `createRequestHandler` is a pure function over a fixed
route set — `/` and `/index.html` (the HTML page, sent with the strict
Content-Security-Policy), `/client.js`, `/client-lib.js`, `/styles.css`,
`/api/graph` (the current graph as JSON), and `/events` (the Server-Sent-Events
stream) — and every other path returns 404. No filesystem path is ever derived
from the request URL, which removes path-traversal as a class of bug. The handler
receives the graph through a getter rather than a captured value, because the
server reassigns the graph on each rebuild and every request must serve the latest
one.

Live reload is driven by the filesystem watch. A change under the wiki triggers a
debounced (150 ms) rebuild; on success the server broadcasts an SSE `reload` event
to every open `/events` subscriber, and the browser refetches `/api/graph`. A
rebuild failure is logged and does not crash the server. The `/events` handler
registers each response in a live set and removes it when the connection closes.

```mermaid
sequenceDiagram
  participant Browser
  participant Server
  participant Watch as FS Watch
  Browser->>Server: GET / (HTML with CSP)
  Browser->>Server: GET /api/graph (initial data)
  Browser->>Server: GET /events (subscribe SSE)
  Watch->>Server: file change (debounced 150ms)
  Server->>Server: rebuild graph
  Server-->>Browser: SSE reload event
  Browser->>Server: GET /api/graph (refetch)
```

Live-reload flow from an edit on disk to a refreshed browser.

The server lifecycle glue (listen/retry, watch, browser launch, banner) requires a
real socket and filesystem and is excluded from coverage, while the pure routing
logic is extracted into `createRequestHandler` so it can be unit-tested without
booting a server.

## Reader client and graph rendering

The browser client (`src/visualize/client.ts`) fetches the graph, then builds three
coordinated views: the force-directed graph canvas, a type/color legend, and a
sidebar index of every page grouped by type. Clicking a node — on the canvas, in
the sidebar, via a backlink chip, or through an in-page wiki link — opens that page
in the reader without moving the camera, so reading never yanks the graph out from
under you. The hint and legend are not standalone panels: `renderPage` nests the
`#graph-overlay` (the `#hint` line plus the `#legend`) directly inside the `#graph`
div, and the stylesheet caps that overlay with `position: absolute` and a
`max-height` against the graph panel's own box. Anchoring the overlay to `#graph`
rather than to `.main` keeps it confined to the graph column, so a wiki with many
page types can no longer grow the legend into a full-width bar that covers the
sidebar, the graph, and the reader.

Clicking empty graph space is deliberately a no-op. The graph instance registers
only `onNodeClick` and `onNodeHover`; there is no `onBackgroundClick` handler, so a
stray click on blank canvas never clears the selection or the reader. This is the
issue #670 regression fix — the former background-click handler wiped the page the
user was reading.

The reader renders the page body as Markdown. Because `marked` passes raw HTML
through, the output is sanitized with DOMPurify before assignment to `innerHTML`,
which is defense in depth on top of the server's CSP; all scalar wiki fields
(title, type, tags) are additionally HTML-escaped by `escapeHtml`, the single XSS
gate for wiki text. Fenced `mermaid` code blocks in the reader are upgraded into
rendered diagrams, and in-page Markdown links whose targets resolve to a known node
are rewritten into in-app navigation. The reader also surfaces each page's
backlinks ("Referenced by") derived from the graph.

Rendering is designed to survive live reloads without disruption. `signature`
computes a stable fingerprint of the graph topology (node ids plus directed edges);
when a reload leaves the topology unchanged the scene and viewport are left
completely untouched, and when it changes the client re-feeds data while reusing
persisted per-id node objects so layout and camera stay put. Node colors are
assigned by `colorsForTypes`, mapping each distinct type to a palette entry by
position so the graph canvas and legend always agree. The client detects its mode
from the `data-static-export` attribute on the document element: static exports read
`./graph.json` and never open an SSE connection, while live mode reads `/api/graph`
and subscribes to `/events`.

The pure, DOM-independent helpers used by the client — `escapeHtml`,
`colorsForTypes`, `nodeRadius`, `signature`, `matchesFilter`, `normalize`,
`stripFrontmatter`, and `hexA` — live in `src/visualize/client-lib.ts` so they can
be unit-tested directly without a browser.

## Static export

`exportStaticVisualizer` in `src/visualize/static-export.ts` writes a self-contained
directory that can be hosted without OpenWiki running. It builds the graph, then
writes `index.html` (the static variant of the page), `client.js`, `client-lib.js`,
`styles.css`, and a pretty-printed `graph.json` into the output directory. Because
the static page carries its own CSP `<meta>` tag, loads assets from sibling paths,
and the client reads `./graph.json` instead of hitting the server, the export needs
no live server and no SSE — the live/stale pill simply reads "Static".

The HTML for both modes is produced by a single `renderPage` function in
`src/visualize/page.ts`, parameterized by whether it is a static export; this keeps
the live and exported apps identical apart from asset URLs, the CSP delivery
mechanism, and the live indicator — including the shared DOM layout, where the
hint-plus-legend overlay lives inside the `#graph` panel rather than as a sibling of
it. The three browser libraries (force-graph, marked, DOMPurify) plus mermaid load
from `cdn.jsdelivr.net` at pinned exact versions with Subresource Integrity hashes,
and the CSP forbids inline scripts, so the reader stays locked down even while
rendering arbitrary wiki Markdown.

## Build pipeline and assets

The client TypeScript is compiled separately from the server code. The `build`
script in `package.json` runs `tsc -p tsconfig.json`, then `tsc -p
tsconfig.client.json` (which compiles `client.ts` and its imported `client-lib.ts`
with DOM libs enabled), and finally `node scripts/copy-visualize-assets.cjs`. That
last step exists because `styles.css` is a hand-authored asset TypeScript does not
emit: the copy script explicitly copies `src/visualize/styles.css` into
`dist/visualize/styles.css` and fails the build if the source is missing, the
`dist/visualize` directory does not exist (a sign the build did not run first), or
the copied file ends up missing or empty. At runtime `loadVisualizerAssets` reads
`client.js`, `client-lib.js`, and `styles.css` from beside the compiled module in
`dist`, which is why the copy step must run before the server or an export can serve
the stylesheet.

## Related pages

- [OKF output](../concepts/okf-output.md) — the frontmatter shape the graph reads.
- [CLI reference](../operations/cli-reference.md) — full `openwiki visualize` flags.
- [Testing overview](../testing/overview.md) — how the visualizer is tested.
