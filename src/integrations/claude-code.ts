import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  coverageSelfCheck,
  documentationGoals,
  okfFrontMatterRules,
  okfRelationshipModeling,
  sectionQualityRules,
  type MethodologyContext,
} from "../agent/prompt.js";

/**
 * Scaffolds Claude Code skills that generate and maintain an OpenWiki wiki
 * using the host coding agent's own inference — no OpenWiki provider or API
 * key. Claude Code runs on the user's own credentials as a native Anthropic
 * application, so nothing here routes requests through OpenWiki.
 *
 * The wiki-methodology bulk (documentation goals, OKF front matter, concept
 * graph, section quality, coverage) is imported from the same functions the
 * OpenWiki agent prompt uses, so the skills cannot drift from the CLI. Only the
 * pieces the CLI performs *outside* the agent — writing `.last-update.json`,
 * generating directory `index.md`, and getting OKF front matter right with no
 * post-run repair — are authored here, since a keyless host agent cannot invoke
 * them.
 */

/**
 * A rendered skill file and its path relative to the scaffold target.
 */
export interface ScaffoldedSkill {
  /** Path relative to the target directory, e.g. `.claude/skills/openwiki-init/SKILL.md`. */
  relativePath: string;
  /** Full SKILL.md contents. */
  content: string;
}

const SKILLS_DIR = path.join(".claude", "skills");

/**
 * Methodology paths for the Claude Code surface. Unlike OpenWiki's own runtime,
 * whose filesystem tools expose the wiki at a virtual root, Claude Code's tools
 * take real repo-relative paths — so the wiki is addressed as `openwiki/...`,
 * never `/openwiki/...`.
 */
const CLAUDE_CODE_CONTEXT: MethodologyContext = {
  docsLocation: "the repository's openwiki/ directory",
  planPath: "openwiki/_plan.md",
  quickstartPath: "openwiki/quickstart.md",
};

/**
 * The shared, drift-proof methodology, rendered for the Claude Code surface.
 * `repairPass: false` because there is no OpenWiki post-run pass here.
 */
function sharedMethodology(): string {
  const ctx = CLAUDE_CODE_CONTEXT;
  return [
    documentationGoals(ctx),
    okfRelationshipModeling(ctx),
    okfFrontMatterRules(ctx, { repairPass: false }),
    sectionQualityRules(ctx),
    coverageSelfCheck(ctx),
  ].join("\n\n");
}

/**
 * The keyless delta: everything the OpenWiki CLI does deterministically outside
 * the agent, which a host coding agent must reproduce by hand.
 */
function keylessDelta(): string {
  return `Reserved files (never treat these as concept pages):
- \`index.md\` — deterministic navigation index (see below). No concept front matter, except the wiki-root \`openwiki/index.md\`, which carries only \`okf_version: "0.1"\`.
- \`log.md\` — reserved OKF document. No concept front matter.
- \`openwiki/INSTRUCTIONS.md\` — a user-authored brief. Read it for scope and priorities; never create, rewrite, or reformat it unless the user explicitly asks to change the brief.

Directory indexes (you must write these yourself):
OpenWiki's CLI regenerates \`index.md\` deterministically after each run. There is no such pass here, so write one \`index.md\` in \`openwiki/\` and in every subdirectory, reproducing this exact format so a later CLI run leaves them untouched:

<index_format>
# Files

- [Title](page-name.md) - description text
- [Another Page](another.md)

# Directories

- [architecture](architecture/)
</index_format>

- Only the root index \`openwiki/index.md\` is prefixed with \`---\\nokf_version: "0.1"\\n---\` and a blank line. Subdirectory indexes have no front matter.
- The Files section lists \`.md\` files in that directory, excluding \`index.md\`, \`log.md\`, \`_plan.md\`, \`INSTRUCTIONS.md\`, and dotfiles. Label = the page's front-matter \`title\` when non-empty, else the filename without \`.md\`; escape \`\\\`, \`[\`, \`]\` in labels. Href = the filename, URL-encoded. Append \` - <description>\` when the page has a non-empty front-matter \`description\` (files only, never directories).
- The Directories section lists non-hidden subdirectories; href = name + \`/\`, label = name.
- Sort both sections by href ascending. Omit an empty section; if both are empty the file is just \`# Files\`. End with a single trailing newline.

Root agent instruction files:
- Do not create or edit \`AGENTS.md\` or \`CLAUDE.md\`. OpenWiki's CLI manages them itself, between \`<!-- OPENWIKI:START -->\` / \`<!-- OPENWIKI:END -->\` markers. Writing an unmarked \`## OpenWiki\` section makes the CLI append a duplicate on its next run.

Run metadata (you must write this yourself):
- After a run that changed wiki content, write \`openwiki/.last-update.json\` with exactly these keys:
  \`updatedAt\` (real UTC ISO-8601 from \`date -u +%Y-%m-%dT%H:%M:%S.000Z\` — run it, don't guess), \`command\` (\`"init"\` or \`"update"\`), \`gitHead\` (\`git rev-parse HEAD\`, omit if not a git repo), and \`model\` (your model id, or \`"claude-code"\`).

Discovery discipline:
- Use your own tools: Read, Glob, Grep, and Bash (for \`git\` and \`rg\`). Do not call the \`openwiki\` CLI, and do not require any API key — you are the inference engine.
- Prefer \`rg --files\` with excludes (\`.git\`, \`node_modules\`, \`dist\`, \`build\`, caches, \`openwiki/\`) and short targeted reads over full-file reads. Never glob \`**/*\` from the repo root.
- Ground every claim in source, existing docs, or git evidence you inspected. Never invent files, modules, APIs, or behavior.
- Never read or document secrets, credentials, tokens, or \`.env\` files. Keep all writes under \`openwiki/\`, plus the run metadata above.`;
}

const INIT_FRONT_MATTER = `---
name: openwiki-init
description: Generate a first-pass OpenWiki-format documentation wiki for this repository using your own inference (no API key). Use when asked to create, initialize, generate, or bootstrap OpenWiki docs / a repo wiki.
---`;

const UPDATE_FRONT_MATTER = `---
name: openwiki-update
description: Surgically update an existing OpenWiki-format wiki to reflect recent code changes, using your own inference (no API key). Use when asked to update, refresh, or sync the OpenWiki docs / repo wiki.
---`;

function renderInitSkill(): string {
  return `${INIT_FRONT_MATTER}

# OpenWiki: init

Build a first-pass OpenWiki-format wiki for the current repository, doing the work yourself with your own tools. Write the wiki under \`openwiki/\`. If \`openwiki/\` already exists with real content, switch to the update behavior instead of overwriting it.

## Process

1. Confirm the repo root. Capture \`git rev-parse HEAD\` for metadata and skim \`git log --oneline -20\` for high-signal context. If it is not a git repo, proceed and omit \`gitHead\`.
2. If \`openwiki/INSTRUCTIONS.md\` exists, read it — it is the user's authored scope and priorities. Never write to it.
3. Inventory the repository with targeted discovery (entrypoints, package/config files, domain folders, routing, schema, tests, scripts).
4. Write a temporary \`openwiki/_plan.md\` (with OKF front matter, e.g. \`type: Plan\`) listing intended pages, their evidence, and the concept relationships to link. Delete it before finishing.
5. Write \`openwiki/quickstart.md\` first, then the smallest set of linked section pages that explains the repo well.
6. Generate directory \`index.md\` files, delete \`openwiki/_plan.md\`, and write \`openwiki/.last-update.json\` with \`command: "init"\`.

${sharedMethodology()}

${keylessDelta()}`;
}

function renderUpdateSkill(): string {
  return `${UPDATE_FRONT_MATTER}

# OpenWiki: update

Refresh the existing \`openwiki/\` wiki so it reflects recent source changes, doing the work yourself with your own tools. If \`openwiki/\` does not exist, tell the user to run the init skill first and stop.

## Process

1. Read \`openwiki/.last-update.json\`; prefer its \`gitHead\` as the baseline, else its \`updatedAt\`.
2. If \`openwiki/INSTRUCTIONS.md\` exists, read it for scope and priorities. Never write to it.
3. Find what changed: \`git diff <gitHead>..HEAD --stat\`, then targeted diffs on high-signal files, plus \`git status\`/\`git diff\` for uncommitted changes. If git is unavailable, infer from timestamps and source.
4. Edit surgically — only pages made inaccurate by the changes. Prefer replacing a stale sentence over adding paragraphs. No formatting-only edits.
5. Soft diff budget: if fewer than ~5 source files changed, edit at most 1-2 pages, and avoid \`openwiki/quickstart.md\` unless top-level behavior, setup, or navigation changed.
6. If you added, removed, renamed, or retitled a page — or changed a page's \`title\`/\`description\` — regenerate the affected \`index.md\`. If nothing relevant changed, make no edits at all (leave \`.last-update.json\` untouched) and say the wiki is already current.
7. If you changed wiki content, write \`openwiki/.last-update.json\` with \`command: "update"\`.

${sharedMethodology()}

${keylessDelta()}`;
}

/**
 * Renders both Claude Code skills and their target-relative paths.
 */
export function renderClaudeCodeSkills(): ScaffoldedSkill[] {
  return [
    {
      relativePath: path.join(SKILLS_DIR, "openwiki-init", "SKILL.md"),
      content: renderInitSkill(),
    },
    {
      relativePath: path.join(SKILLS_DIR, "openwiki-update", "SKILL.md"),
      content: renderUpdateSkill(),
    },
  ];
}

/**
 * Writes the Claude Code skills under `targetDir/.claude/skills/`. Only files
 * inside `.claude/skills/` are ever written. Returns the absolute paths written.
 */
export async function writeClaudeCodeSkills(
  targetDir: string,
): Promise<string[]> {
  const written: string[] = [];
  for (const skill of renderClaudeCodeSkills()) {
    const absolute = path.join(targetDir, skill.relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `${skill.content}\n`, "utf8");
    written.push(absolute);
  }
  return written;
}
