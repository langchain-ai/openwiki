import { describe, expect, test } from "vitest";
import {
  PALETTE,
  colorsForTypes,
  escapeHtml,
  hexA,
  matchesFilter,
  nodeRadius,
  normalize,
  signature,
  stripFrontmatter,
} from "../src/visualize/client-lib.ts";

describe("escapeHtml", () => {
  test("escapes the HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;",
    );
  });

  test("leaves a plain string untouched", () => {
    expect(escapeHtml("just text")).toBe("just text");
  });
});

describe("colorsForTypes", () => {
  test("assigns palette colors by position", () => {
    expect(colorsForTypes(["A", "B"], ["#111", "#222", "#333"])).toEqual({
      A: "#111",
      B: "#222",
    });
  });

  test("wraps around when there are more types than colors", () => {
    const colors = colorsForTypes(["A", "B", "C"], ["#111", "#222"]);
    expect(colors.C).toBe("#111");
  });

  test("defaults to the shared PALETTE", () => {
    expect(colorsForTypes(["A"]).A).toBe(PALETTE[0]);
  });
});

describe("hexA", () => {
  test("expands #RRGGBB plus alpha into rgba()", () => {
    expect(hexA("#4FA8F0", 0.5)).toBe("rgba(79, 168, 240, 0.5)");
  });

  test("returns a non-6-digit input unchanged", () => {
    expect(hexA("#abc", 0.5)).toBe("#abc");
    expect(hexA("", 1)).toBe("");
  });
});

describe("nodeRadius", () => {
  test("scales with size and caps the size contribution", () => {
    expect(nodeRadius(0, false)).toBe(4);
    expect(nodeRadius(480, false)).toBe(5);
    expect(nodeRadius(100000, false)).toBe(11); // 4 + min(7, huge)
  });

  test("adds a bonus for the anchor page", () => {
    expect(nodeRadius(0, true)).toBe(8);
  });
});

describe("matchesFilter", () => {
  const node = {
    id: "arch/overview",
    title: "Overview",
    type: "Section",
    tags: ["core"],
  };

  test("empty query and type match everything", () => {
    expect(matchesFilter(node, "", "")).toBe(true);
  });

  test("matches free text across title, id, and tags", () => {
    expect(matchesFilter(node, "overview", "")).toBe(true);
    expect(matchesFilter(node, "arch", "")).toBe(true);
    expect(matchesFilter(node, "core", "")).toBe(true);
    expect(matchesFilter(node, "missing", "")).toBe(false);
  });

  test("filters by exact type", () => {
    expect(matchesFilter(node, "", "Section")).toBe(true);
    expect(matchesFilter(node, "", "Reference")).toBe(false);
  });
});

describe("signature", () => {
  test("is stable regardless of node and edge order", () => {
    const a = {
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [{ source: "a", target: "b" }],
    };
    const b = {
      nodes: [{ id: "b" }, { id: "a" }],
      edges: [{ source: "a", target: "b" }],
    };
    expect(signature(a)).toBe(signature(b));
  });

  test("changes when an edge is added", () => {
    const base = { nodes: [{ id: "a" }, { id: "b" }], edges: [] };
    const linked = {
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [{ source: "a", target: "b" }],
    };
    expect(signature(base)).not.toBe(signature(linked));
  });
});

describe("stripFrontmatter", () => {
  test("removes a leading frontmatter block", () => {
    expect(stripFrontmatter("---\ntitle: X\n---\n# Body\n")).toBe("# Body\n");
  });

  test("returns a body without frontmatter unchanged", () => {
    expect(stripFrontmatter("# Body\n")).toBe("# Body\n");
  });
});

describe("normalize", () => {
  test("resolves a sibling link within a directory", () => {
    expect(normalize("arch", "server.md")).toBe("arch/server.md");
  });

  test("collapses .. and . segments", () => {
    expect(normalize("arch/deep", "../server.md")).toBe("arch/server.md");
    expect(normalize("arch", "./server.md")).toBe("arch/server.md");
  });

  test("resolves from the wiki root when baseDir is empty", () => {
    expect(normalize("", "index.md")).toBe("index.md");
  });
});
