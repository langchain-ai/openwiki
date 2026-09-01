// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Behavioral tests for the visualizer client's graph interaction wiring.
 *
 * `src/visualize/client.ts` is browser-only render glue (it touches the DOM at
 * import time and drives CDN globals), so it cannot be imported in a plain Node
 * test. Here it is imported under jsdom with the third-party globals (force-graph,
 * marked, DOMPurify, mermaid) replaced by recording stubs, which lets us assert
 * on the handlers the client actually registers — in particular the issue #670
 * regression: clicking empty graph space must not clear the reader.
 */

interface RecordedHandlers {
  onNodeClick?: (node: unknown) => void;
  onNodeHover?: (node: unknown) => void;
  onBackgroundClick?: (handler: () => void) => void;
  backgroundClickHandler?: () => void;
}

const handlers: RecordedHandlers = {};

const graphPayload = {
  root: "sample-wiki",
  generatedAt: "2026-01-01T00:00:00Z",
  types: ["Guide"],
  nodes: [
    {
      id: "quickstart",
      title: "Quickstart",
      type: "Guide",
      description: "Entry page",
      tags: ["start"],
      body: "# Quickstart\n\nHello world",
      size: 100,
      links: ["overview"],
      backlinks: [],
    },
    {
      id: "overview",
      title: "Overview",
      type: "Guide",
      description: "",
      tags: [],
      body: "# Overview",
      size: 50,
      links: [],
      backlinks: ["quickstart"],
    },
  ],
  edges: [{ source: "quickstart", target: "overview" }],
};

/** Minimal DOM mirroring the structure page.ts renders (post-#670 layout). */
function mountDom(): void {
  document.body.innerHTML = `
    <div class="topbar">
      <div class="title">OpenWiki<small id="wiki-name"></small></div>
      <div class="live-pill" id="live"><span id="live-text"></span></div>
      <div class="icon-btn" id="toggle-graph"></div>
      <div class="icon-btn" id="theme"></div>
    </div>
    <div class="main" id="main">
      <nav class="sidebar" id="sidebar"></nav>
      <div id="graph">
        <div class="graph-overlay" id="graph-overlay">
          <div class="graph-hint" id="hint"></div>
          <div class="legend" id="legend"></div>
        </div>
      </div>
      <div class="splitter" id="splitter"></div>
      <div class="detail" id="detail"><div class="empty">Select a page</div></div>
    </div>
    <div class="toast" id="toast"></div>`;
}

function stubGlobals(): void {
  // The force-graph instance is itself callable: ForceGraph()(element) mounts.
  const instance = (() => instance) as unknown as Record<string, unknown> &
    ((element?: unknown) => unknown);
  const chain = () => instance;
  Object.assign(instance, {
    backgroundColor: chain,
    nodeRelSize: chain,
    nodeCanvasObjectMode: chain,
    nodeCanvasObject: chain,
    nodePointerAreaPaint: chain,
    linkColor: chain,
    linkWidth: chain,
    linkCurvature: chain,
    linkDirectionalParticles: chain,
    linkDirectionalParticleWidth: chain,
    linkDirectionalParticleSpeed: chain,
    linkDirectionalParticleColor: chain,
    pauseAnimation: chain,
    resumeAnimation: chain,
    width: chain,
    height: chain,
    zoom: chain,
    graphData: (data?: unknown) =>
      data === undefined ? { nodes: [], links: [] } : instance,
    d3Force: () => ({ strength: () => {} }),
    onNodeClick: (h: (node: unknown) => void) => {
      handlers.onNodeClick = h;
      return instance;
    },
    onNodeHover: (h: (node: unknown) => void) => {
      handlers.onNodeHover = h;
      return instance;
    },
    onBackgroundClick: (h: () => void) => {
      handlers.backgroundClickHandler = h;
      return instance;
    },
  });

  vi.stubGlobal("ForceGraph", () => instance);
  vi.stubGlobal("marked", {
    parse: (md: string) => `<p>${md}</p>`,
    setOptions: () => {},
  });
  vi.stubGlobal("DOMPurify", { sanitize: (dirty: string) => dirty });
  vi.stubGlobal("mermaid", { initialize: () => {}, run: () => {} });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ json: () => Promise.resolve(graphPayload) })),
  );
  // jsdom does not implement scrollIntoView.
  Element.prototype.scrollIntoView = () => {};
}

async function importClient(): Promise<void> {
  mountDom();
  stubGlobals();
  // Static-export mode skips the SSE connection, so no EventSource stub needed.
  document.documentElement.dataset.staticExport = "true";
  await import("../../src/visualize/client.ts");
  // Wait for the bootstrap load(true) promise to populate the sidebar.
  await vi.waitFor(() => {
    expect(document.querySelectorAll(".nav-item").length).toBe(2);
  });
}

describe("visualizer client graph interaction", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    handlers.onNodeClick = undefined;
    handlers.onNodeHover = undefined;
    handlers.onBackgroundClick = undefined;
    handlers.backgroundClickHandler = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("registers node click and hover handlers", async () => {
    await importClient();
    expect(typeof handlers.onNodeClick).toBe("function");
    expect(typeof handlers.onNodeHover).toBe("function");
  });

  // Regression for issue #670: clicking blank graph space used to be wired to
  // clearSelection, wiping the page the user was reading. Background clicks
  // must not be wired to any page-state change at all.
  test("does not wire background clicks to any handler", async () => {
    await importClient();
    expect(handlers.backgroundClickHandler).toBeUndefined();
  });

  test("a selected page stays open (nothing else clears the reader)", async () => {
    await importClient();
    handlers.onNodeClick!({ id: "overview" });
    expect(document.getElementById("detail")!.textContent).toContain(
      "Overview",
    );
    // The only former path to the empty state was the background click; with
    // it gone the reader content must remain untouched.
    expect(document.querySelector("#detail .empty")).toBeNull();
  });

  test("selecting a node highlights the sidebar entry", async () => {
    await importClient();
    handlers.onNodeClick!({ id: "overview" });
    const active = document.querySelector(".nav-item.active");
    expect(active?.textContent).toContain("Overview");
  });
});
