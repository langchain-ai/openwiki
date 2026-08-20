import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { validateOkfFrontmatter } from "../../src/okf/frontmatter.ts";

const SKILL_ROOT = path.join(process.cwd(), "integrations/openwiki");
const SKILL_PATH = path.join(SKILL_ROOT, "SKILL.md");
const REFERENCE_PATHS = [
  "references/init.md",
  "references/methodology.md",
  "references/security.md",
  "references/update.md",
] as const;
const MARKDOWN_PATHS = ["SKILL.md", ...REFERENCE_PATHS] as const;
const LONG_REFERENCE_LINE_COUNT = 100;

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

  test("keeps every Markdown reference local and resolvable", async () => {
    for (const markdownPath of MARKDOWN_PATHS) {
      const absolutePath = path.join(SKILL_ROOT, markdownPath);
      const markdown = await readFile(absolutePath, "utf8");

      for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
        const target = match[1];
        if (!target || target.startsWith("#")) continue;

        const resolved = path.resolve(path.dirname(absolutePath), target);
        expect(resolved.startsWith(`${SKILL_ROOT}${path.sep}`)).toBe(true);
        expect((await stat(resolved)).isFile()).toBe(true);
      }
    }
  });

  test("gives long references a contents list", async () => {
    for (const referencePath of REFERENCE_PATHS) {
      const reference = await readFile(
        path.join(SKILL_ROOT, referencePath),
        "utf8",
      );
      const lineCount = reference.split(/\r?\n/u).length;

      if (lineCount > LONG_REFERENCE_LINE_COUNT) {
        expect(reference).toContain("## Contents");
      }
    }

    const methodology = await readFile(
      path.join(SKILL_ROOT, "references/methodology.md"),
      "utf8",
    );
    expect(methodology).toContain("## Contents");
  });

  test("places native host authoring between begin and finish", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
    const requiredSequence = section(skill, "Required sequence");
    const beginIndex = requiredSequence.indexOf("`openwiki_begin`");
    const authoringIndex = requiredSequence.indexOf(
      "Create, edit, or delete factual pages",
    );
    const finishIndex = requiredSequence.indexOf("`openwiki_finish`");

    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(authoringIndex).toBeGreaterThan(beginIndex);
    expect(finishIndex).toBeGreaterThan(authoringIndex);
    expect(requiredSequence).toContain("with native tools");
  });

  test("resolves and passes an explicit Git root before begin", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
    const requiredSequence = section(skill, "Required sequence");
    const resolveIndex = requiredSequence.indexOf(
      "`git rev-parse --show-toplevel`",
    );
    const beginIndex = requiredSequence.indexOf("`openwiki_begin`");

    expect(resolveIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeGreaterThan(resolveIndex);
    expect(requiredSequence).toContain(
      "`git -C <path> rev-parse --show-toplevel`",
    );
    expect(requiredSequence).toContain("with `root` and `mode`");
    expect(requiredSequence).toContain("default to the home directory");
    expect(requiredSequence).toContain("stop and ask the user");
  });

  test("keeps deterministic work and reserved artifacts code-owned", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");

    expect(skill).toContain(
      "Use OpenWiki for deterministic preparation and finalization.",
    );
    expect(skill).toContain(
      "Perform repository\ninvestigation and factual Markdown authoring with native host tools.",
    );
    expect(skill).toContain(
      "Never edit indexes, logs, metadata, plans, or skeleton files.",
    );
  });

  test("contains no lifecycle or page-transaction tool drift", async () => {
    const bundle = (
      await Promise.all(
        MARKDOWN_PATHS.map((relativePath) =>
          readFile(path.join(SKILL_ROOT, relativePath), "utf8"),
        ),
      )
    ).join("\n");
    const toolNames = [
      ...new Set(
        [...bundle.matchAll(/\b(openwiki_[a-z_]+)\b/gu)].map(
          (match) => match[1],
        ),
      ),
    ].sort();

    expect(toolNames).toEqual(["openwiki_begin", "openwiki_finish"]);
  });

  test("provides a valid OKF frontmatter example", async () => {
    const methodology = await readFile(
      path.join(SKILL_ROOT, "references/methodology.md"),
      "utf8",
    );
    const example = /```yaml\r?\n([\s\S]*?)\r?\n```/u.exec(methodology)?.[1];

    expect(example).toBeDefined();
    expect(validateOkfFrontmatter(example ?? "")).toEqual({ valid: true });
  });

  test("keeps Codex metadata aligned and the skill concise", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
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
    expect(skill.split(/\r?\n/u).length).toBeLessThan(500);
  });
});
