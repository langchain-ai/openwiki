import type { OpenWikiIgnore } from "./openwiki-ignore.js";
import { CODE_SYSTEM_PROMPTS, CODE_USER_PROMPTS } from "./prompts/code.js";
import {
  PERSONAL_SYSTEM_PROMPTS,
  PERSONAL_USER_PROMPTS,
} from "./prompts/personal.js";
import type {
  OpenWikiCommand,
  OpenWikiOutputMode,
  RunContext,
  UpdateMetadata,
} from "./types.js";

export {
  CODE_SYSTEM_PROMPTS,
  CODE_USER_PROMPTS,
  PERSONAL_SYSTEM_PROMPTS,
  PERSONAL_USER_PROMPTS,
};

export function createSystemPrompt(
  command: OpenWikiCommand,
  outputMode: OpenWikiOutputMode = "local-wiki",
  language?: string,
  openWikiIgnore?: OpenWikiIgnore,
): string {
  const template =
    outputMode === "repository"
      ? CODE_SYSTEM_PROMPTS[command]
      : PERSONAL_SYSTEM_PROMPTS[command];

  return template
    .replace(
      "{OUTPUT_LANGUAGE_INSTRUCTIONS}",
      formatLanguageInstructions(language),
    )
    .replace("{GIT_HISTORY_HINT}", formatGitHistoryHint(openWikiIgnore))
    .replace(
      "{DISCOVERY_INSTRUCTION}",
      formatDiscoveryInstruction(openWikiIgnore),
    )
    .replace(
      "{OPENWIKIIGNORE_INSTRUCTIONS}",
      formatOpenWikiIgnoreInstructions(openWikiIgnore),
    )
    .trim();
}

export function createUserPrompt(
  command: OpenWikiCommand,
  context: RunContext,
  userMessage: string | null = null,
  outputMode: OpenWikiOutputMode = "local-wiki",
  runtimeRoot?: string,
): string {
  const template =
    outputMode === "repository"
      ? CODE_USER_PROMPTS[command]
      : PERSONAL_USER_PROMPTS[command];

  return template
    .replace("{USER_MESSAGE}", userMessage?.trim() || "Start an OpenWiki chat.")
    .replace("{WIKI_GOAL}", context.wikiGoal?.trim() || "(not provided)")
    .replace("{LAST_UPDATE}", formatLastUpdate(context.lastUpdate))
    .replace(
      "{ADDITIONAL_USER_REQUEST}",
      userMessage?.trim()
        ? `Additional user instruction:\n${userMessage.trim()}`
        : "",
    )
    .replace(
      "{RUNTIME_CONTEXT}",
      runtimeRoot ? formatRuntimeContext(runtimeRoot, outputMode) : "",
    )
    .trim();
}

export function formatRuntimeRootInstruction(
  outputMode: OpenWikiOutputMode,
): string {
  if (outputMode === "local-wiki") {
    return "Filesystem tools use a virtual root: / means the local wiki directory above. Write wiki pages directly under /, for example /quickstart.md, /sources/gmail.md, and /_plan.md. Do not create a nested /openwiki directory.";
  }

  return "Filesystem tools use a virtual root: / means the repository root. The generated repository wiki lives under /openwiki, for example /openwiki/quickstart.md and /openwiki/architecture/overview.md. Inspect source files from repository-root paths such as /README.md, /src/agent/index.ts, and /package.json.";
}

function formatLastUpdate(lastUpdate: UpdateMetadata | null): string {
  if (lastUpdate === null) {
    return "No previous OpenWiki update metadata was found.";
  }

  return JSON.stringify(lastUpdate, null, 2);
}

function formatLanguageInstructions(language: string | undefined): string {
  if (!language) {
    return "";
  }

  return `

Output language:
- Write generated wiki prose, headings, table content, and documentation in ${language}.
- OpenWiki has already brought existing pages into ${language} in a separate deterministic pass before you run, so treat the wiki as already in ${language}. Do not translate or rewrite an existing page just because it, or the recorded run metadata, still shows a different language; that whole-wiki reconciliation is code-owned. Write only your own new or changed content in ${language} and leave otherwise-accurate pages alone.
- In each page's YAML front matter, write the human-readable "title", "description", and "type" values in ${language}. Do this even when the value is dense with product names, feature names, or technical terminology; within those values keep unchanged only literal code identifiers, file paths, commands, and URLs. Write the "tags" values in English so they stay stable across languages as cross-cutting aggregation keys. Keep the YAML keys as written, and copy any URL, file path, timestamp, or identifier-like value byte-for-byte.
- Apply this language only to generated wiki files. Do not translate OpenWiki CLI text or runtime messages.
- Keep code identifiers, file paths, commands, API names, URLs, and code blocks unchanged where translation would reduce technical accuracy or usability.`;
}

function formatGitHistoryHint(openWikiIgnore?: OpenWikiIgnore): string {
  return openWikiIgnore?.isActive
    ? "Git history is unavailable while .openwikiignore is active; rely on allowed source files and tests without bypassing the restriction. "
    : "Read git history when it helps establish repository context or explain why code exists. ";
}

function formatDiscoveryInstruction(openWikiIgnore?: OpenWikiIgnore): string {
  return openWikiIgnore?.isActive
    ? "- Do not call glob with **/* from the root. Use targeted ls, glob, and grep by directory and extension, skipping .git, node_modules, dist, build, cache directories, and existing generated wiki output."
    : "- Do not call glob with **/* from the root. Use targeted discovery by directory and extension. Prefer shell commands like rg --files with excludes for .git, node_modules, dist, build, cache directories, and existing generated wiki output.";
}

function formatOpenWikiIgnoreInstructions(
  openWikiIgnore?: OpenWikiIgnore,
): string {
  if (!openWikiIgnore?.isActive) {
    return "\n";
  }

  const patterns = openWikiIgnore.patterns
    .map((pattern) => `  - ${JSON.stringify(pattern)}`)
    .join("\n");

  return `


.openwikiignore discipline:
- This repository has .openwikiignore rules. Treat matching paths as out of scope.
- Filesystem tools enforce these rules; if a tool reports an excluded path, do not retry through shell execute.
- For repository discovery use ls, read_file, glob, and grep; these keep exclusions enforced. Shell execute is limited to a few maintenance commands while .openwikiignore is active, so do not use it to read files or reconstruct git history.
- Do not document excluded paths or infer details about their contents.
- Active patterns:
${patterns}`;
}

function formatRuntimeContext(
  runtimeRoot: string,
  outputMode: OpenWikiOutputMode,
): string {
  const rootLabel =
    outputMode === "local-wiki" ? "Local wiki root" : "Repository root";

  return `${rootLabel}:
${runtimeRoot}

Runtime note:
- ${formatRuntimeRootInstruction(outputMode)}
- Do not pass host absolute paths to filesystem tools. A host absolute path will be treated as a virtual path and will write to the wrong location.
- Shell execute commands run on the host. For execute, use cd ${runtimeRoot} before commands that should run against this root.
- Do not search parent directories or unrelated directories.`;
}
