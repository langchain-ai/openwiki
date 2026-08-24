import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { CODE_SYSTEM_PROMPTS } from "../../src/agent/prompts/code.ts";
import { validateOkfFrontmatter } from "../../src/okf/frontmatter.ts";

const SKILL_ROOT = path.join(process.cwd(), "integrations/openwiki");
const SKILL_PATH = path.join(SKILL_ROOT, "SKILL.md");
const REFERENCE_PATHS = [
  "references/init.md",
  "references/methodology.md",
  "references/reviewers.md",
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

  test("places the host workflow between begin and finish", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
    const requiredSequence = section(skill, "Required sequence");
    const beginIndex = requiredSequence.indexOf("`openwiki_begin`");
    const workflowIndex = requiredSequence.indexOf(
      "Execute every planning, evidence, authoring, and review gate",
    );
    const finishIndex = requiredSequence.indexOf("`openwiki_finish`");

    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(workflowIndex).toBeGreaterThan(beginIndex);
    expect(finishIndex).toBeGreaterThan(workflowIndex);
    expect(requiredSequence).toContain("host-native subagents");
    expect(requiredSequence).toContain(
      "never delegate the same domain's research\n   twice",
    );
    expect(requiredSequence).toMatch(
      /keep Claims and factual edits in the main\s+agent/u,
    );
    expect(
      requiredSequence.indexOf("`openwiki_inspect_claims`"),
    ).toBeGreaterThan(beginIndex);
    expect(
      requiredSequence.indexOf("`openwiki_resolve_claims`"),
    ).toBeGreaterThan(beginIndex);
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

  test("separates temporary agent artifacts from deterministic output", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
    const security = await readFile(
      path.join(SKILL_ROOT, "references/security.md"),
      "utf8",
    );

    expect(skill).toContain(
      "Use OpenWiki for deterministic preparation and finalization.",
    );
    expect(skill).toContain(
      "investigation, planning, review, and factual Markdown authoring with native host\n" +
        "tools and host-native delegation.",
    );
    expect(skill).toContain(
      "Never edit indexes, logs, provenance, or run metadata.",
    );
    expect(skill).toContain(
      "Never edit the OpenWiki-managed blocks in root `AGENTS.md` or `CLAUDE.md`",
    );
    expect(skill).toContain(
      "may author the temporary `openwiki/_skeleton.md` and\n" +
        "  `openwiki/_plan.md`",
    );
    expect(skill).toContain("OpenWiki removes them during finalization.");
    expect(security).toContain(
      "temporary `_skeleton.md` or `_plan.md` required by the selected workflow",
    );
    expect(skill).toContain("Never edit `openwiki/.claims` directly");
    expect(security).toContain("Never\nedit `openwiki/.claims`");
    expect(security).not.toMatch(/never edit[^.]*plans?[^.]*skeletons?/iu);
  });

  test("mirrors native init orchestration gates", async () => {
    const init = await readFile(
      path.join(SKILL_ROOT, "references/init.md"),
      "utf8",
    );
    const reviewers = await readFile(
      path.join(SKILL_ROOT, "references/reviewers.md"),
      "utf8",
    );
    const nativeInit = CODE_SYSTEM_PROMPTS.init;

    expect(nativeInit).toContain("/openwiki/_plan.md");
    expect(init).toContain("`openwiki/_plan.md`");
    expect(nativeInit).toContain("`skeleton-critic` subagent");
    expect(init).toContain("run the skeleton critic");
    expect(nativeInit).toContain("Invoke `skeleton-critic` exactly once more");
    expect(init).toContain("critic exactly once more");
    expect(nativeInit).toContain("unknown-unknown pass");
    expect(init).toContain("unknown-unknown pass");
    expect(nativeInit).toContain("`wiki-question-finder`");
    expect(init).toContain("Invoke the question finder");
    expect(nativeInit).toContain("`wiki-answer-verifier`");
    expect(init).toContain("launch verifier batches");
    expect(nativeInit).toContain("batches of 2–3");
    expect(reviewers).toContain("batches of two or three");
    expect(nativeInit).toContain("PARTIAL or FAIL");
    expect(init).toContain("`PARTIAL` or `FAIL`");
    expect(nativeInit).toContain("write /openwiki/quickstart.md");
    expect(init).toContain("`openwiki/quickstart.md`, then write it last");
    expect(nativeInit).toContain("through resolve_claims");
    expect(init).toContain("`openwiki_resolve_claims`");
    expect(init).toContain("starts init from a blank generated wiki");
    expect(nativeInit).toContain("This is a brand-new generation");
    expect(init).toContain("Information architecture section");
    expect(init).toContain("flat collection of Markdown files");
    expect(init).toContain(
      "quickstart domain containing multiple pages should correspond",
    );
    expect(init).toContain("Do not use umbrella names such as");
    expect(init).toContain("Treat every planned page");
    expect(init).toContain("until every taxonomy request is resolved");
    expect(init).toContain("skeleton critic is the only delegated role");
    expect(init).toContain(
      "Do not launch standalone domain\n   research or evidence-brief subagents during planning",
    );
    expect(init).toContain(
      "at most nine host-native evidence\n   subagents total",
    );
    expect(init).toContain(
      "Do not create a separate repository-wide evidence-brief phase",
    );
    expect(init).toContain("delegate the\n   same domain twice");
    expect(init).toContain(
      "performs only narrow source verification needed to establish Claims",
    );
    expect(init).toContain(
      "do not wait for a second evidence pass over the complete inventory",
    );
    expect(init).toContain(
      "Never introduce an ad-hoc path absent from the plan",
    );
    expect(reviewers).toContain("durable information architecture");
    expect(reviewers).toContain("root must not be a dumping ground");
    expect(reviewers).toContain("Reject umbrella directories such as");
    expect(reviewers).toContain(
      "Every information-architecture request must name the exact planned",
    );
  });

  test("preserves native reviewer evidence isolation", async () => {
    const reviewers = await readFile(
      path.join(SKILL_ROOT, "references/reviewers.md"),
      "utf8",
    );

    expect(reviewers).toContain(
      "Independently map the repository before reading `openwiki/_plan.md`",
    );
    expect(reviewers).toContain(
      "Read repository source and tests only; never read `openwiki/`",
    );
    expect(reviewers).toContain(
      "Read `openwiki/` only; never inspect source or tests",
    );
    expect(reviewers).toContain("Never\nlet a reviewer edit the plan or wiki.");
  });

  test("mirrors native update planning discipline", async () => {
    const update = await readFile(
      path.join(SKILL_ROOT, "references/update.md"),
      "utf8",
    );
    const nativeUpdate = CODE_SYSTEM_PROMPTS.update;

    expect(nativeUpdate).toContain("/openwiki/_plan.md");
    expect(update).toContain("`openwiki/_plan.md`");
    expect(nativeUpdate).toContain(
      "Revisit the plan after initial discovery and again after drafting",
    );
    expect(update).toContain("Revisit the plan after discovery");
    expect(update).toContain("Revisit the plan after drafting");
    expect(nativeUpdate).toContain(
      "avoid subagents unless the user explicitly requests them",
    );
    expect(update).toContain("Work in the main agent by default");
    expect(update).toContain("delegate bounded evidence or review tasks");
    expect(update).toContain("Keep the impact plan and all factual edits");
    expect(update).toContain("`updatePreflight.shouldSkip` is `true`");
    expect(update).toContain("call `openwiki_finish`\n   immediately");
    expect(nativeUpdate).toContain("inspect_claims");
    expect(nativeUpdate).toContain("resolve_claims");
    expect(update).toContain("`openwiki_inspect_claims`");
    expect(update).toContain("`openwiki_resolve_claims`");
  });

  test("uses the lifecycle language for authored prose", async () => {
    const methodology = await readFile(
      path.join(SKILL_ROOT, "references/methodology.md"),
      "utf8",
    );

    expect(methodology).toContain(
      "Write factual prose in the `language` returned by `openwiki_begin`",
    );
    expect(methodology).toContain(
      "On an explicit language switch,\ntranslate every factual page",
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

    expect(toolNames).toEqual([
      "openwiki_begin",
      "openwiki_finish",
      "openwiki_inspect_claims",
      "openwiki_resolve_claims",
    ]);
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
