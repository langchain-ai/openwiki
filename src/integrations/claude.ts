import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
    // The target repo is untrusted input: a cloned/checked-out repo can commit
    // a symlink at any segment of this path. mkdir({recursive:true}) and
    // writeFile both follow symlinks by default, so without this check a
    // malicious repo could redirect the write to overwrite an arbitrary
    // victim-writable file outside the target directory.
    await assertNoSymlinkInPath(resolvedTarget, skillPath);
    await mkdir(path.dirname(skillPath), { recursive: true });
    // Re-check the leaf immediately before writing: mkdir only touches
    // ancestor directories, so a symlink planted at the leaf itself would
    // otherwise survive the check above undetected until this point.
    await assertNoSymlinkInPath(resolvedTarget, skillPath);
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

// Refuses to proceed if any path segment between `root` and `targetPath`
// (inclusive of the leaf) already exists as a symlink, so a repo cannot use a
// planted symlink to redirect our write outside the intended `.claude/skills`
// tree. Missing segments are fine (they don't exist yet, so nothing to
// hijack); only an existing symlink is rejected.
async function assertNoSymlinkInPath(
  root: string,
  targetPath: string,
): Promise<void> {
  const relative = path.relative(root, targetPath);
  let current = root;

  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);

    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return;
      }

      throw error;
    }

    if (stats.isSymbolicLink()) {
      throw new Error(
        `Refusing to write through a symlink at ${current}. Remove it and re-run.`,
      );
    }
  }
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
