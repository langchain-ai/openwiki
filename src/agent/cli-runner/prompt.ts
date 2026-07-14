import {
  createDocumentationGoalSections,
  createModeInstructions,
  createSecuritySection,
  createStewardshipSections,
  createUserPrompt,
  getOutputPromptConfig,
  OPENWIKI_CLI_REFERENCE,
  type OutputPromptConfig,
} from "../prompt.js";
import type { OpenWikiProvider } from "../../constants.js";
import type {
  OpenWikiCommand,
  OpenWikiOutputMode,
  OpenWikiRunOptions,
  RunContext,
} from "../types.js";

export function getCliOutputPromptConfig(
  outputMode: OpenWikiOutputMode,
): OutputPromptConfig {
  const base = getOutputPromptConfig(outputMode);

  if (outputMode === "repository") {
    return {
      ...base,
      docsLocation: "the repository's openwiki/ directory",
      filesystemRootInstruction:
        "You are running inside the target repository checkout with your own native file and shell tools. Use real repository-relative paths. Create and update generated wiki pages only under openwiki/, such as openwiki/quickstart.md or openwiki/architecture/overview.md.",
      metadataPath: "openwiki/.last-update.json",
      planPath: "openwiki/_plan.md",
      quickstartPath: "openwiki/quickstart.md",
      removePlanCommand: "rm -f openwiki/_plan.md",
      rootAgentInstructions: `Root agent instruction files:
- Do not create or update AGENTS.md or CLAUDE.md files at the repository root during normal code wiki runs.
- Keep generated wiki content under the repository openwiki/ directory.
- openwiki/INSTRUCTIONS.md is the shared, user-authored OpenWiki brief for this repository. Treat it as control metadata: read it to understand scope and priorities, but do not edit it during normal init/update/chat runs unless the user explicitly asks to change the brief.
- Generated documentation pages should live under openwiki/, but openwiki/INSTRUCTIONS.md itself is not generated documentation and should not be rewritten as part of routine wiki maintenance.
- If repository agent instructions already reference OpenWiki, keep those references accurate but do not edit them unless explicitly asked.`,
      writeBoundaryInstruction:
        "Do not modify source code. Write generated wiki pages only under the repository's openwiki/ directory.",
      writePathExample:
        "repository-relative paths under openwiki/, for example openwiki/quickstart.md or openwiki/architecture/overview.md",
    };
  }

  return {
    ...base,
    docsLocation: "the local wiki directory (your current working directory)",
    filesystemRootInstruction:
      "You are running inside the local wiki directory (~/.openwiki/wiki) with your own native file and shell tools. Use real paths relative to the current working directory, such as quickstart.md, sources/gmail.md, and topics/ai-research.md. Do not create a nested openwiki/ directory.",
    localWikiSynthesisInstruction: toCwdRelativeCanonicalPaths(
      base.localWikiSynthesisInstruction,
    ),
    metadataPath: ".last-update.json",
    planPath: "_plan.md",
    quickstartPath: "quickstart.md",
    removePlanCommand: "rm -f _plan.md",
    writeBoundaryInstruction:
      "Do not modify files outside the current working directory (~/.openwiki/wiki). The only source data outside this directory that may be inspected is connector raw data or explicit shell reads requested by the source-specific prompt.",
    writePathExample:
      "paths relative to the current working directory, for example quickstart.md or sources/gmail.md",
  };
}

/**
 * Rewrites the base config's virtual-root canonical wiki references
 * (/quickstart.md, /themes.md, /sources/<connector>.md, ...) to cwd-relative
 * form for CLI runs, preserving the rest of the text verbatim.
 */
function toCwdRelativeCanonicalPaths(text: string): string {
  return text.replace(
    /(^|[\s(,])\/(quickstart\.md|open-questions\.md|themes\.md|commitments\.md|personal-logistics\.md|sources\/)/g,
    "$1$2",
  );
}

export function createCliSystemPrompt(
  command: OpenWikiCommand,
  outputMode: OpenWikiOutputMode,
  engine: OpenWikiProvider,
): string {
  const output = getCliOutputPromptConfig(outputMode);
  // Parity with the base createSystemPrompt, which renders this block. It is
  // populated only for local-wiki mode; repository mode leaves it "" so the
  // trailing separator collapses and no stray blank section is emitted.
  const localWikiSynthesis = output.localWikiSynthesisInstruction
    ? `${output.localWikiSynthesisInstruction}\n\n`
    : "";

  return `
You are OpenWiki, an expert technical writer, software architect, and product analyst.

Your job is to inspect the relevant source evidence, then produce documentation in ${output.docsLocation} that is excellent for both humans and future agents.

Run discipline:
- ${output.filesystemRootInstruction}
- Use your own built-in file discovery, read, write, and shell tools. Prefer targeted reads over full-file reads when files are large.
- Do not exhaustively read every file. Inspect the repository tree, package/config files, README-style files, entrypoints, routing files, database/schema files, and representative files for each major domain.
- Prefer commands like rg --files with excludes for .git, node_modules, dist, build, cache directories, and existing generated wiki output.
- Create a strong first-pass wiki that is accurate and navigable, then stop. The wiki can be refined in later update runs.
- Keep the initial documentation set focused: quickstart plus the smallest set of section pages needed to explain the repo clearly.
- ${output.searchBoundaryInstruction}

${createDocumentationGoalSections(output)}

${localWikiSynthesis}${createStewardshipSections(output)}

${createSecuritySection(output)}

${output.rootAgentInstructions}

${createCliSubagentSection(engine)}

${OPENWIKI_CLI_REFERENCE}

Mode-specific behavior:
${createModeInstructions(command, outputMode, output)}
`.trim();
}

function createCliSubagentSection(engine: OpenWikiProvider): string {
  if (engine !== "claude-code") {
    return "";
  }

  return `
Subagent discipline:
- You may use your subagent/task tool to parallelize read-only research during init and update runs when the repository has multiple substantial domains.
- Default to 1-2 subagents. Subagents must only inspect and summarize; the main agent must synthesize the final docs and perform all writes.
`.trim();
}

export function createCliUserPrompt(
  command: OpenWikiCommand,
  cwd: string,
  context: RunContext,
  options: OpenWikiRunOptions,
  outputMode: OpenWikiOutputMode,
): string {
  if (options.isFollowup === true && options.userMessage?.trim()) {
    return options.userMessage.trim();
  }

  const output = getCliOutputPromptConfig(outputMode);
  const rootLabel =
    outputMode === "local-wiki" ? "Local wiki root" : "Repository root";

  return `
${createUserPrompt(command, context, options.userMessage ?? null, outputMode, output)}

${rootLabel} (your current working directory):
${cwd}

Runtime note:
- You are running with your own native file and shell tools on the host filesystem. All relative paths resolve against the working directory above.
- ${output.writeBoundaryInstruction}
- Do not search parent directories or unrelated directories outside the working directory above.
`.trim();
}
