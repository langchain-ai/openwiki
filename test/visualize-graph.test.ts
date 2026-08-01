import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildGraph,
  firstHeading,
  splitFrontmatter,
} from "../src/visualize/graph.ts";

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
