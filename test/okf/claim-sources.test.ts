import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OpenWikiLocalShellBackend } from "../../src/agent/docs-only-backend.ts";
import { synchronizeClaimSources } from "../../src/okf/claim-sources.ts";
import { parseFrontmatterFields } from "../../src/okf/frontmatter.ts";

/**
 * Creates one isolated repository wiki and its guarded backend.
 */
async function setup() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-sources-"));
  const backend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    outputMode: "repository",
    rootDir,
    virtualMode: true,
  });
  return { backend, rootDir };
}

/**
 * Mirrors the stable public ID expected for one projected resource.
 */
function openWikiSourceId(resource: string): string {
  return `openwiki-source-${createHash("sha256").update(resource).digest("hex").slice(0, 24)}`;
}

describe("synchronizeClaimSources", () => {
  test("projects sorted unique evidence and preserves independent sources", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/page.md",
      [
        "---",
        "type: Reference",
        "sources:",
        "  - id: external-policy",
        "    resource: https://example.com/policy",
        "    author: human:owner",
        "generated: {by: openwiki/0.3.3, at: 2026-08-20T00:00:00Z}",
        "---",
        "",
        "# Page",
        "",
      ].join("\n"),
    );

    await synchronizeClaimSources(
      backend,
      "repository",
      new Map([
        [
          "/openwiki/page.md",
          [
            "repo://src/z.ts#L4-L8",
            "repo://src/z.ts#L20-L22",
            "repo://src/a.ts",
            "repo://src/a.ts#L1-L2",
          ],
        ],
      ]),
    );

    const content = await readFile(
      path.join(rootDir, "openwiki/page.md"),
      "utf8",
    );
    const sources = parseFrontmatterFields(content)?.sources;
    expect(sources).toEqual([
      {
        author: "human:owner",
        id: "external-policy",
        resource: "https://example.com/policy",
      },
      {
        id: openWikiSourceId("repo://src/a.ts"),
        resource: "repo://src/a.ts",
      },
      {
        id: openWikiSourceId("repo://src/z.ts"),
        resource: "repo://src/z.ts",
      },
    ]);
    expect(content).toContain(
      "generated: {by: openwiki/0.3.3, at: 2026-08-20T00:00:00Z}",
    );
    expect(content).toContain("# Page");
  });

  test("reconciles only code-owned entries and is idempotent", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/page.md",
      "---\ntype: Reference\nsources:\n  - id: manual\n    resource: repo://manual.ts\n  - id: openwiki-source-old\n    resource: repo://old.ts\n---\n\n# Page\n",
    );
    const resources = new Map([
      ["/openwiki/page.md", ["repo://new.ts"] as const],
    ]);

    await synchronizeClaimSources(backend, "repository", resources);
    const afterFirst = await readFile(
      path.join(rootDir, "openwiki/page.md"),
      "utf8",
    );
    expect(afterFirst).toContain("repo://manual.ts");
    expect(afterFirst).toContain("repo://new.ts");
    expect(afterFirst).not.toContain("repo://old.ts");

    const write = vi.spyOn(backend, "write");
    await synchronizeClaimSources(backend, "repository", resources);
    expect(write).not.toHaveBeenCalled();
  });

  test("leaves pages without Claims state untouched", async () => {
    const { backend, rootDir } = await setup();
    const content =
      "---\ntype: Reference\nsources:\n  - resource: https://example.com/manual\n---\n\n# Page\n";
    await backend.write("/openwiki/page.md", content);

    await synchronizeClaimSources(backend, "repository", new Map());

    await expect(
      readFile(path.join(rootDir, "openwiki/page.md"), "utf8"),
    ).resolves.toBe(content);
  });
});
