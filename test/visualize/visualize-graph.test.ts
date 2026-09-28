import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildGraph,
  firstHeading,
  splitFrontmatter,
} from "../../src/visualize/graph.ts";

const tempDirs: string[] = [];

async function makeWiki(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-viz-"));
  tempDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("splitFrontmatter", () => {
  test("parses scalars, inline lists, and dashed lists", () => {
    const { meta, body } = splitFrontmatter(
      [
        "---",
        "type: Reference",
        'title: "Quoted Title"',
        "tags: [alpha, beta]",
        "authors:",
        "  - Ada",
        "  - Grace",
        "---",
        "# Heading",
        "",
        "Body text.",
      ].join("\n"),
    );
    expect(meta.type).toBe("Reference");
    expect(meta.title).toBe("Quoted Title");
    expect(meta.tags).toEqual(["alpha", "beta"]);
    expect(meta.authors).toEqual(["Ada", "Grace"]);
    expect(body.startsWith("# Heading")).toBe(true);
  });

  test("returns the raw body when there is no frontmatter", () => {
    const { meta, body } = splitFrontmatter("# Just markdown\n");
    expect(meta).toEqual({});
    expect(body).toBe("# Just markdown\n");
  });
});

describe("firstHeading", () => {
  test("returns the first H1 or undefined", () => {
    expect(firstHeading("intro\n# Title\n")).toBe("Title");
    expect(firstHeading("no heading here")).toBeUndefined();
  });
});

describe("buildGraph", () => {
  test("builds nodes, resolves links to edges, and records backlinks", async () => {
    const root = await makeWiki({
      "index.md": "---\ntype: Section\n---\n# Files\n[Arch](architecture.md)\n",
      "architecture.md":
        "---\ntype: Reference\ntitle: Architecture\n---\n# Architecture\nSee [home](index.md).\n",
      "INSTRUCTIONS.md": "scaffolding, must be excluded",
    });

    const graph = await buildGraph(root);

    // INSTRUCTIONS.md is excluded; the two real pages remain.
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([
      "architecture",
      "index",
    ]);
    // Root index.md is titled "Home", not its generic "# Files" heading.
    expect(graph.nodes.find((n) => n.id === "index")?.title).toBe("Home");
    expect(graph.nodes.find((n) => n.id === "architecture")?.title).toBe(
      "Architecture",
    );
    // Two directed edges, one each way.
    expect(graph.edges).toContainEqual({
      source: "index",
      target: "architecture",
    });
    expect(graph.edges).toContainEqual({
      source: "architecture",
      target: "index",
    });
    // Backlinks are recorded on the target node.
    expect(
      graph.nodes.find((n) => n.id === "architecture")?.backlinks,
    ).toContain("index");
  });

  test("ignores links to non-existent pages and self-links", async () => {
    const root = await makeWiki({
      "a.md": "# A\n[missing](nope.md) and [self](a.md)\n",
    });
    const graph = await buildGraph(root);
    expect(graph.edges).toEqual([]);
  });

  test("decodes Unicode and special-character links and records backlinks", async () => {
    const name = "靖难之役 #1%.md";
    const href = encodeURIComponent(name);
    const root = await makeWiki({
      "events/index.md": `[Event](${href})\n[Same event](${href}#details)\n[Person](../${encodeURIComponent("人物")}/${encodeURIComponent("朱棣.md")})\n`,
      [`events/${name}`]: "# Event\n",
      "人物/朱棣.md": "# Person\n",
      "literal.md": "[Decode once](%25E4%25B8%2580.md)\n",
      "%E4%B8%80.md": "# Literal percent-encoded filename\n",
    });

    const graph = await buildGraph(root);

    expect(graph.edges).toHaveLength(3);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { source: "events/index", target: "events/靖难之役 #1%" },
        { source: "events/index", target: "人物/朱棣" },
        { source: "literal", target: "%E4%B8%80" },
      ]),
    );
    expect(
      graph.nodes.find((n) => n.id === "events/靖难之役 #1%")?.backlinks,
    ).toEqual(["events/index"]);
  });

  test("preserves raw percent and Unicode filenames and deduplicates encoded links", async () => {
    const root = await makeWiki({
      "index.md":
        "[Progress](progress100%.md)\n[Encoded progress](progress100%25.md)\n[Unicode](朱棣.md)\n",
      "progress100%.md": "# Progress\n",
      "朱棣.md": "# Person\n",
      "raw.md": "[Progress](progress100%.md)\n",
    });

    const graph = await buildGraph(root);

    expect(graph.edges).toHaveLength(3);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { source: "index", target: "progress100%" },
        { source: "index", target: "朱棣" },
        { source: "raw", target: "progress100%" },
      ]),
    );
    expect(graph.nodes.find((n) => n.id === "progress100%")?.backlinks).toEqual(
      ["index", "raw"],
    );
  });

  test("malformed URL encoding does not prevent valid graph links", async () => {
    const root = await makeWiki({
      "index.md":
        "[Invalid escape](bad%ZZ.md)\n[Incomplete encoding](%E4%B8.md)\n[Valid page](valid.md)\n",
      "valid.md": "# Valid page\n",
    });

    const graph = await buildGraph(root);

    expect(graph.edges).toEqual([{ source: "index", target: "valid" }]);
  });

  test("does not follow a symlink that escapes the wiki root", async () => {
    const secret = await mkdtemp(path.join(tmpdir(), "openwiki-secret-"));
    tempDirs.push(secret);
    await writeFile(path.join(secret, "leak.md"), "# Secret\n", "utf8");

    const root = await makeWiki({ "index.md": "# Home\n" });
    // A symlink inside the wiki pointing outside it must not be collected.
    await symlink(secret, path.join(root, "escape"));

    const graph = await buildGraph(root);
    expect(graph.nodes.some((n) => n.id.includes("leak"))).toBe(false);
  });
});
