import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  renderRootIndex,
  stripNonRootIndexFrontmatter,
} from "../../src/agent/okf/reserved.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "okf-reserved-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("renderRootIndex", () => {
  test("declares okf_version and groups /-rooted links by type", () => {
    const index = renderRootIndex([
      {
        relativePath: "domain/orders.md",
        type: "Domain Concept",
        title: "Orders",
        description: "Order lifecycle.",
      },
      {
        relativePath: "architecture/overview.md",
        type: "Architecture",
        title: "Overview",
        description: undefined,
      },
    ]);

    expect(index).toContain('okf_version: "0.1"');
    // Types are grouped and sorted; links are bundle-absolute.
    expect(index).toContain(
      "## Architecture\n- [Overview](/architecture/overview.md)",
    );
    expect(index).toContain(
      "## Domain Concept\n- [Orders](/domain/orders.md) — Order lifecycle.",
    );
    expect(index.indexOf("## Architecture")).toBeLessThan(
      index.indexOf("## Domain Concept"),
    );
  });
});

describe("stripNonRootIndexFrontmatter", () => {
  test("removes frontmatter from a non-root index.md but leaves the root untouched", async () => {
    await mkdir(path.join(root, "domain"), { recursive: true });
    await writeFile(
      path.join(root, "domain", "index.md"),
      "---\ntype: Section\n---\n# Domain\n\n- listing\n",
    );
    await writeFile(
      path.join(root, "index.md"),
      '---\nokf_version: "0.1"\n---\n# Index\n',
    );

    await stripNonRootIndexFrontmatter(root, ["domain/index.md", "index.md"]);

    const domainIndex = await readFile(
      path.join(root, "domain", "index.md"),
      "utf8",
    );
    expect(domainIndex.startsWith("---")).toBe(false);
    expect(domainIndex).toBe("# Domain\n\n- listing\n");

    // The root index.md is skipped by this pass (it legitimately has frontmatter).
    const rootIndex = await readFile(path.join(root, "index.md"), "utf8");
    expect(rootIndex.startsWith("---")).toBe(true);
  });
});
