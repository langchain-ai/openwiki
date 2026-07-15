import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isFileNotFoundError } from "../fs-errors.js";

// From dist/integrations/claude.js (or src/integrations/claude.ts) this resolves
// to the package-root templates/claude-skill directory shipped in the npm
// package. Matches the bundled-asset pattern in agent/skills.ts.
const CLAUDE_SKILL_TEMPLATE_DIR = fileURLToPath(
  new URL("../../templates/claude-skill", import.meta.url),
);

type ClaudeSkillDefinition = {
  name: string;
  templateFile: string;
};

// The skills scaffolded into a target repository. Each maps to a bundled
// template whose body becomes the SKILL.md instruction set.
const CLAUDE_SKILLS: ClaudeSkillDefinition[] = [
  { name: "openwiki-init", templateFile: "openwiki-init.md" },
  { name: "openwiki-update", templateFile: "openwiki-update.md" },
];

export type ClaudeIntegrationResult = {
  targetDir: string;
  writtenFiles: string[];
  nextSteps: string[];
};

type ParsedTemplate = {
  frontmatter: Record<string, string>;
  body: string;
};

/**
 * Scaffolds the OpenWiki Claude Code skills into `targetDir`.
 *
 * Reads each bundled template, lifts its `description`/`argument-hint`
 * frontmatter into a valid Claude Code SKILL.md header, and writes
 * `<targetDir>/.claude/skills/<skill>/SKILL.md`. Existing files are overwritten
 * in place because these are managed, generated artifacts.
 */
export async function writeClaudeIntegration(
  targetDir: string,
): Promise<ClaudeIntegrationResult> {
  const resolvedTarget = path.resolve(targetDir);
  await assertDirectory(resolvedTarget);

  const writtenFiles: string[] = [];

  for (const definition of CLAUDE_SKILLS) {
    const templatePath = path.join(
      CLAUDE_SKILL_TEMPLATE_DIR,
      definition.templateFile,
    );
    const raw = await readFile(templatePath, "utf8");
    const parsed = parseTemplate(raw, definition.templateFile);
    const document = buildSkillDocument(definition, parsed);

    const skillPath = path.join(
      resolvedTarget,
      ".claude",
      "skills",
      definition.name,
      "SKILL.md",
    );
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, document, "utf8");
    writtenFiles.push(skillPath);
  }

  return {
    targetDir: resolvedTarget,
    writtenFiles,
    nextSteps: [
      "Open the target repository in Claude Code.",
      "Run /openwiki-init to generate the initial docs under openwiki/.",
      "Run /openwiki-update after source changes to refresh them.",
    ],
  };
}

async function assertDirectory(dir: string): Promise<void> {
  let stats;

  try {
    stats = await stat(dir);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new Error(`Target directory does not exist: ${dir}`, {
        cause: error,
      });
    }

    throw error;
  }

  if (!stats.isDirectory()) {
    throw new Error(`Target path is not a directory: ${dir}`);
  }
}

function parseTemplate(raw: string, templateFile: string): ParsedTemplate {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);

  if (!match) {
    throw new Error(
      `Bundled skill template ${templateFile} is missing a frontmatter block.`,
    );
  }

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = stripQuotes(line.slice(separatorIndex + 1).trim());
    frontmatter[key] = value;
  }

  return {
    frontmatter,
    body: normalized.slice(match[0].length).trim(),
  };
}

function stripQuotes(value: string): string {
  const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
  const isSingleQuoted = value.startsWith("'") && value.endsWith("'");

  if (value.length >= 2 && (isDoubleQuoted || isSingleQuoted)) {
    return value.slice(1, -1);
  }

  return value;
}

function buildSkillDocument(
  definition: ClaudeSkillDefinition,
  parsed: ParsedTemplate,
): string {
  const description = parsed.frontmatter.description ?? "";
  const argumentHint = parsed.frontmatter["argument-hint"] ?? "";

  const lines = [
    "---",
    `name: ${definition.name}`,
    `description: ${toYamlDoubleQuoted(description)}`,
    ...(argumentHint.length > 0
      ? [`argument-hint: ${toYamlDoubleQuoted(argumentHint)}`]
      : []),
    "user-invocable: true",
    "disable-model-invocation: false",
    "---",
    "",
    parsed.body,
    "",
  ];

  return lines.join("\n");
}

// Emit a YAML double-quoted scalar so values that would otherwise be misparsed
// (e.g. an argument-hint like "[path]" reads as a flow sequence when bare) stay
// strings. Only backslash and double-quote need escaping inside double quotes.
function toYamlDoubleQuoted(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  return `"${escaped}"`;
}
