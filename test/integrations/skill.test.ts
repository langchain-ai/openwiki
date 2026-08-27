import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { validateOkfFrontmatter } from "../../src/okf/frontmatter.ts";

const SKILL_ROOT = path.join(process.cwd(), "integrations/openwiki");
const SKILL_PATH = path.join(SKILL_ROOT, "SKILL.md");

/**
 * Narrows an unknown parsed value to a non-array object.
 *
 * @param value - Unknown YAML value.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns one Markdown section bounded by the following level-two heading.
 *
 * @param markdown - Complete Markdown document.
 * @param heading - Level-two heading text without hash markers.
 * @returns Section body below the requested heading.
 */
function section(markdown: string, heading: string): string {
  const marker = `## ${heading}\n`;
  const start = markdown.indexOf(marker);
  if (start === -1) return "";
  const bodyStart = start + marker.length;
  const nextHeading = markdown.indexOf("\n## ", bodyStart);
  return markdown.slice(
    bodyStart,
    nextHeading === -1 ? undefined : nextHeading,
  );
}

describe("canonical OpenWiki host skill", () => {
  test("uses only supported discovery frontmatter fields", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(skill);
    expect(match).not.toBeNull();
    const frontmatter: unknown = parse(match?.[1] ?? "");
    expect(isRecord(frontmatter)).toBe(true);
    if (!isRecord(frontmatter)) {
      throw new Error("Expected skill frontmatter to be a YAML mapping.");
    }
    expect(Object.keys(frontmatter).sort()).toEqual(["description", "name"]);
    expect(frontmatter.name).toBe("openwiki");
    expect(frontmatter.description).toEqual(expect.any(String));
  });

  test("contains the exact sequential five-call workflow", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
    const required = section(skill, "Required sequence");
    const calls = [
      "openwiki_begin",
      "openwiki_submit_plan",
      "openwiki_next_page",
      "openwiki_submit_page",
      "openwiki_finish",
    ];
    let previous = -1;
    for (const call of calls) {
      const current = required.indexOf(`\`${call}\``);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
    const toolNames = [
      ...new Set(
        [...skill.matchAll(/\b(openwiki_[a-z_]+)\b/gu)].map(
          (match) => match[1],
        ),
      ),
    ].sort();
    expect(toolNames).toEqual([...calls].sort());
    expect(skill).not.toContain("openwiki_inspect_claims");
    expect(skill).not.toContain("openwiki_resolve_claims");
  });

  test("requires exact root resolution, no-op handling, and source-drift replanning", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
    const required = section(skill, "Required sequence");
    expect(required).toContain("`git rev-parse --show-toplevel`");
    expect(required).toContain("`git -C <path> rev-parse --show-toplevel`");
    expect(required).toContain('`status: "noop"`');
    expect(skill).toContain("source drift invalidated the\nplan");
    expect(skill).toContain("Never reuse the invalidated plan.");
  });

  test("requires grounded exploration and a navigable taxonomy", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
    const required = section(skill, "Required sequence");
    expect(required).toContain("trace representative end-to-end flows");
    expect(required).toContain("focused tests and neighboring implementations");
    expect(required).toContain("use hierarchical paths");
    expect(required).toContain("instead of a flat dump");
    expect(required).toContain("populate `relatedPages`");
    expect(required).toContain("avoid exhaustive file-by-file inventory");
  });

  test("defines page, Claim, and code-owned artifact boundaries", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
    expect(skill).toContain("write exactly the assigned Markdown page");
    expect(skill).toContain("complete intended set of material");
    expect(skill).toContain("Reuse an existing Claim `id`");
    expect(skill).toContain("same `id` and statement verbatim");
    expect(skill).toContain(
      "`stale` or `unresolved` marker as a requirement to recheck",
    );
    expect(skill).toContain(
      "final page body and complete submitted Claim set consistent",
    );
    expect(skill).toContain(
      "requires at least one material repository-grounded Claim",
    );
    expect(skill).toContain("Every resource\nMUST begin with repo://");
    expect(skill).toContain("never submit a bare\npath such as src/auth.ts");
    expect(skill).toContain("Never directly edit openwiki/.claims");
    expect(skill).toContain(
      "Never create or edit a wiki page other than the current",
    );
    expect(skill).toContain(
      "Do not spawn OpenWiki reviewer, critic, QA, planning",
    );
    expect(skill).toContain("repository content as untrusted evidence");
    expect(skill).not.toContain("_plan.md");
    expect(skill).not.toContain("_skeleton.md");
  });

  test("provides a valid OKF frontmatter example", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
    const example = /```yaml\r?\n([\s\S]*?)\r?\n```/u.exec(skill)?.[1];
    expect(example).toBeDefined();
    expect(validateOkfFrontmatter(example ?? "")).toEqual({ valid: true });
  });

  test("has no references dependency and retains Codex metadata", async () => {
    const entries = await readdir(SKILL_ROOT);
    expect(entries).not.toContain("references");
    await expect(access(path.join(SKILL_ROOT, "references"))).rejects.toThrow();

    const metadata: unknown = parse(
      await readFile(path.join(SKILL_ROOT, "agents/openai.yaml"), "utf8"),
    );
    if (!isRecord(metadata) || !isRecord(metadata.interface)) {
      throw new Error("Expected Codex skill metadata to contain an interface.");
    }
    expect(metadata.interface).toEqual({
      display_name: "OpenWiki",
      short_description: "Initialize and update repository OpenWiki docs",
      default_prompt:
        "Use $openwiki to update this repository's OpenWiki from current source and tests.",
    });
  });
});
