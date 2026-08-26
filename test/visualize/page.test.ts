import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PAGE, STATIC_PAGE } from "../../src/visualize/page.ts";

/**
 * The browser libraries the page loads from the jsdelivr CDN, pinned to exact
 * versions with SRI hashes. If a version is bumped the matching hash must change
 * too, so pinning the version string here forces any bump through this test (and
 * a fresh hash review) instead of silently trusting whatever the CDN serves.
 */
const PINNED_CDN_SCRIPTS = [
  {
    name: "force-graph",
    src: "https://cdn.jsdelivr.net/npm/force-graph@1.49.5/dist/force-graph.min.js",
  },
  {
    name: "marked",
    src: "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js",
  },
  {
    name: "dompurify",
    src: "https://cdn.jsdelivr.net/npm/dompurify@3.4.12/dist/purify.min.js",
  },
  {
    name: "mermaid",
    src: "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js",
  },
];

describe("visualizer PAGE", () => {
  test("is a full HTML document", () => {
    expect(PAGE.startsWith("<!doctype html>")).toBe(true);
    expect(PAGE).toContain("<title>OpenWiki visualizer</title>");
  });

  test("loads styles from an external stylesheet in both modes", () => {
    expect(PAGE).toContain('<link rel="stylesheet" href="/styles.css" />');
    expect(STATIC_PAGE).toContain(
      '<link rel="stylesheet" href="./styles.css" />',
    );
    expect(PAGE).not.toMatch(/<style\b/u);
    expect(STATIC_PAGE).not.toMatch(/<style\b/u);
  });

  test.each(PINNED_CDN_SCRIPTS)(
    "loads $name from the pinned CDN version with an SRI hash",
    ({ src }) => {
      // The exact pinned src must be present...
      expect(PAGE).toContain(`src="${src}"`);

      // ...and its <script> tag must carry an integrity + crossorigin attribute
      // so the browser rejects a tampered CDN response.
      const tagStart = PAGE.indexOf(`src="${src}"`);
      const tagEnd = PAGE.indexOf("></script>", tagStart);
      expect(tagEnd).toBeGreaterThan(tagStart);
      const tag = PAGE.slice(tagStart, tagEnd);
      expect(tag).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
      expect(tag).toContain('crossorigin="anonymous"');
    },
  );

  test("every CDN script is SRI-protected (no unprotected script slips in)", () => {
    const cdnScriptCount =
      PAGE.split('src="https://cdn.jsdelivr.net/').length - 1;
    const integrityCount = PAGE.split("integrity=").length - 1;
    expect(cdnScriptCount).toBe(PINNED_CDN_SCRIPTS.length);
    expect(integrityCount).toBe(PINNED_CDN_SCRIPTS.length);
  });

  // Regression: the hint + legend overlays used to be direct children of
  // .main with `position: absolute`, which resolved against the viewport and
  // let a many-type legend grow into a full-width bar covering the sidebar,
  // the graph, and the reader (issue #670). They must live inside #graph so
  // they are capped to the graph panel's own box.
  test("hint and legend are anchored inside the graph panel, not .main", () => {
    for (const doc of [PAGE, STATIC_PAGE]) {
      const mainStart = doc.indexOf('<div class="main" id="main">');
      const detailStart = doc.indexOf('<div class="detail" id="detail">');
      const mainRegion = doc.slice(mainStart, detailStart);

      // The graph panel hosts the overlay...
      const graphStart = doc.indexOf('<div id="graph">');
      const overlayStart = doc.indexOf(
        '<div class="graph-overlay" id="graph-overlay">',
      );
      expect(graphStart).toBeGreaterThan(-1);
      expect(overlayStart).toBeGreaterThan(graphStart);

      // ...and neither element may appear in .main outside #graph.
      expect(mainRegion).toContain('id="graph-overlay"');
      expect(mainRegion).toContain('id="legend"');
      expect(mainRegion).toContain('id="hint"');
      expect(doc.indexOf('id="legend"')).toBeGreaterThan(overlayStart);
      expect(doc.indexOf('id="hint"')).toBeGreaterThan(overlayStart);
    }
  });

  test("the overlay stack is capped to the graph panel and scrolls", () => {
    // The stylesheet must keep the overlay height-capped with a scrollable
    // legend, otherwise a wiki with many page types regrows the overlapping
    // bottom bar from issue #670.
    const css = readFileSync(
      path.join(import.meta.dirname, "../../src/visualize/styles.css"),
      "utf8",
    );
    const overlayBlock = css.match(/\.graph-overlay\s*\{[^}]*\}/u);
    expect(overlayBlock).toBeTruthy();
    expect(overlayBlock![0]).toContain("position: absolute");
    expect(overlayBlock![0]).toContain("max-height:");

    const legendBlock = css.match(/\.legend\s*\{[^}]*\}/u);
    expect(legendBlock).toBeTruthy();
    // Scrollable within the cap, and no longer viewport-anchored.
    expect(legendBlock![0]).toContain("overflow-y: auto");
    expect(legendBlock![0]).not.toContain("position: absolute");
  });
});
