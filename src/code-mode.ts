import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { OPENWIKI_VERSION } from "./constants.js";
import { isFileNotFoundError } from "./fs-errors.js";
import { createConnectorRegistry } from "./connectors/registry.js";
import { UPDATE_METADATA_PATH } from "./constants.js";
import { createConnectorSynthesisGuidance } from "./ingestion.js";
import type { OpenWikiRunEvent } from "./agent/types.js";

const OPENWIKI_AGENTS_SNIPPET_START = "<!-- OPENWIKI:START -->";
const OPENWIKI_AGENTS_SNIPPET_END = "<!-- OPENWIKI:END -->";
const OPENWIKI_AGENTS_BACKUP_SUFFIX = ".openwiki.bak";
const DEFAULT_CODE_MODE_CRON = "0 8 * * *";

// Root agent-instruction files OpenWiki keeps pointed at the generated wiki.
// Each is created when missing and refreshed in place when already present.
const CODE_MODE_AGENT_FILES = ["AGENTS.md", "CLAUDE.md"];

/** Controls which parts of the repo OpenWiki sets up for code mode. */
export interface CodeModeRepoSetupOptions {
  /**
   * Write the scheduled-update workflow file. Only `openwiki code --init`
   * should create it; `--update` and chat runs leave an existing file alone so
   * operator customizations (fork guards, pinned actions, custom steps) are
   * never silently overwritten.
   */
  createWorkflow?: boolean;
  /** Cron expression for a freshly created workflow. Defaults to {@link DEFAULT_CODE_MODE_CRON}. */
  cronExpression?: string;
  /**
   * Sink for warnings about non-canonical content inside the managed
   * agent-instruction blocks. When absent, warnings go to stderr. A throwing
   * sink falls back to stderr and never breaks the run.
   */
  onWarning?: (message: string) => void;
}

/**
 * Ensure the repo is set up for code mode: refresh the managed agent-instruction
 * snippets, and, when `options.createWorkflow` is set, create the scheduled-update
 * workflow if it does not already exist.
 */
export async function ensureCodeModeRepoSetup(
  cwd: string,
  options: CodeModeRepoSetupOptions = {},
): Promise<void> {
  if (options.createWorkflow) {
    await ensureCodeModeWorkflow(
      cwd,
      options.cronExpression ?? DEFAULT_CODE_MODE_CRON,
    );
  }
  await writeCodeModeAgentSnippets(cwd, options.onWarning);
}

/**
 * Create the scheduled-update workflow file only when it is missing. An existing
 * file is preserved verbatim so repo-specific customizations survive repeated
 * runs; a plain overwrite would silently strip them.
 */
async function ensureCodeModeWorkflow(
  cwd: string,
  cronExpression: string,
): Promise<void> {
  const workflowPath = path.join(
    cwd,
    ".github",
    "workflows",
    "openwiki-update.yml",
  );

  try {
    await readFile(workflowPath, "utf8");
    return;
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  await mkdir(path.dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, createCodeModeWorkflow(cronExpression), "utf8");
}

/**
 * Runs every configured code-mode connector for a code-mode agent run and appends
 * their guidance to the agent's message. Returns the base message unchanged when
 * nothing contributes, so an unconfigured repo still noop-skips. Fail-open: a
 * connector that throws is skipped, never allowed to break the update.
 */
export async function runCodeModeConnectors(
  repoRoot: string,
  baseMessage: string | undefined,
  onEvent?: (event: OpenWikiRunEvent) => void,
): Promise<string | undefined> {
  // The natural window: what has happened since we last documented this repo.
  const windowHours = windowHoursSince(await readLastUpdatedAt(repoRoot));
  const blocks: string[] = [];

  for (const connector of Object.values(createConnectorRegistry())) {
    if (connector.mode !== "code") {
      continue;
    }
    // Surface the pull so the otherwise-silent gap before the agent reads as
    // progress ("Ingesting from LangSmith…") instead of a hang.
    emitText(onEvent, `Ingesting from ${connector.displayName}…\n`);
    let pull;
    try {
      // Code connectors read their committed repo config from repoRoot; a repo
      // that has not configured the connector skips, so nothing is appended.
      pull = await connector.ingest({ repoRoot, windowHours });
    } catch {
      // The connector documents software; it must never break the run it feeds.
      emitText(onEvent, `${connector.displayName} ingestion skipped.\n`);
      continue;
    }
    emitText(onEvent, `${pull.message}\n`);
    if (pull.status !== "success" || pull.rawFiles.length === 0) {
      continue;
    }
    const guidance = createConnectorSynthesisGuidance(connector);
    if (guidance) {
      blocks.push(guidance);
    }
  }

  if (blocks.length === 0) {
    return baseMessage;
  }

  const base = baseMessage?.trim();
  const joined = blocks.join("\n\n");
  return base ? `${base}\n\n${joined}` : joined;
}

/**
 * Emits a plain progress line to the run log, matching the agent's text events so
 * connector progress renders in the same stream.
 */
function emitText(
  onEvent: ((event: OpenWikiRunEvent) => void) | undefined,
  text: string,
): void {
  onEvent?.({ source: "main", text, type: "text" });
}

/**
 * Hours elapsed since the last-update timestamp, the code-mode ingestion window.
 * Undefined when since is absent or unparseable (first run), meaning "no floor"
 * so the connector bootstraps with its most recent traces.
 */
function windowHoursSince(since: string | undefined): number | undefined {
  const sinceMs = since !== undefined ? Date.parse(since) : Number.NaN;
  return Number.isNaN(sinceMs)
    ? undefined
    : Math.max(0, (Date.now() - sinceMs) / (60 * 60 * 1000));
}

/**
 * The last-update timestamp from openwiki/.last-update.json, or undefined when it
 * is absent (first run) or unreadable.
 */
async function readLastUpdatedAt(
  repoRoot: string,
): Promise<string | undefined> {
  try {
    const text = await readFile(
      path.join(repoRoot, UPDATE_METADATA_PATH),
      "utf8",
    );
    const parsed = JSON.parse(text) as { updatedAt?: unknown };
    return typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One agent file's prepared outcome. `backupContent` and `warning` are present
 * only when the managed block holds non-canonical content that is about to be
 * replaced. `nextContent` equals `originalContent` when the file should not be
 * rewritten at all (canonical block, or marker-less append already staged).
 */
interface PreparedAgentFile {
  agentsPath: string;
  originalContent: string;
  nextContent: string;
  backupContent?: string;
  warning?: string;
}

async function writeCodeModeAgentSnippets(
  cwd: string,
  onWarning?: (message: string) => void,
): Promise<void> {
  const snippet = createCodeModeAgentsSnippet();
  const warn = createWarningSink(onWarning);

  // Phase 1 — validate and prepare both files in memory. A malformed-marker
  // throw here aborts before any backup or write, so an aborted run never
  // leaves a backup for either file.
  const prepared = await Promise.all(
    CODE_MODE_AGENT_FILES.map((fileName) =>
      prepareCodeModeAgentSnippet(path.join(cwd, fileName), snippet),
    ),
  );

  // Phase 2 — write backups and emit warnings, in agent-file order, before any
  // replacement is written. Backups are sourced from the already-read content,
  // so an editor touching the file in between cannot make the backup diverge.
  for (const file of prepared) {
    if (file.backupContent === undefined) {
      continue;
    }
    await writeBackupAtomically(file.agentsPath, file.backupContent);
    if (file.warning !== undefined) {
      warn(file.warning);
    }
  }

  // Phase 3 — write only files whose content actually changed. Canonical
  // files are skipped entirely, so mtime and line endings stay untouched.
  await Promise.all(
    prepared
      .filter((file) => file.nextContent !== file.originalContent)
      .map(({ agentsPath, nextContent }) =>
        writeFile(agentsPath, nextContent, "utf8"),
      ),
  );
}

/**
 * A warning sink that never breaks the run: a throwing custom sink falls back
 * to stderr, and the default sink writes straight to stderr.
 */
function createWarningSink(
  onWarning: ((message: string) => void) | undefined,
): (message: string) => void {
  if (onWarning === undefined) {
    return (message) => process.stderr.write(`${message}\n`);
  }
  return (message) => {
    try {
      onWarning(message);
    } catch {
      process.stderr.write(`${message}\n`);
    }
  };
}

/**
 * Normalize CRLF and lone-CR line endings to LF so Windows-edited and old-Mac
 * files compare equal to the LF canonical snippet.
 */
function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      return true;
    }
    return false;
  }
}

/**
 * Write the backup copy atomically (temp file plus rename, mirroring the
 * credential-file pattern) so a crash mid-write cannot leave a torn backup.
 */
async function writeBackupAtomically(
  agentsPath: string,
  content: string,
): Promise<void> {
  const backupPath = `${agentsPath}${OPENWIKI_AGENTS_BACKUP_SUFFIX}`;
  const tmpPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, backupPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function prepareCodeModeAgentSnippet(
  agentsPath: string,
  snippet: string,
): Promise<PreparedAgentFile> {
  let currentContent = "";

  try {
    currentContent = await readFile(agentsPath, "utf8");
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  const startIndex = currentContent.indexOf(OPENWIKI_AGENTS_SNIPPET_START);
  const endIndex = currentContent.indexOf(OPENWIKI_AGENTS_SNIPPET_END);
  const hasNoMarkers = startIndex === -1 && endIndex === -1;

  if (hasNoMarkers) {
    return {
      agentsPath,
      originalContent: currentContent,
      nextContent: `${currentContent.trimEnd()}${currentContent.trim().length > 0 ? "\n\n" : ""}${snippet}\n`,
    };
  }

  const hasOneOrderedPair =
    startIndex !== -1 &&
    endIndex > startIndex &&
    startIndex === currentContent.lastIndexOf(OPENWIKI_AGENTS_SNIPPET_START) &&
    endIndex === currentContent.lastIndexOf(OPENWIKI_AGENTS_SNIPPET_END);

  if (!hasOneOrderedPair) {
    throw new Error(
      `Cannot update ${path.basename(agentsPath)} because its OpenWiki managed markers are malformed or duplicated. Expected either no markers or exactly one ${OPENWIKI_AGENTS_SNIPPET_START} marker followed by one ${OPENWIKI_AGENTS_SNIPPET_END} marker. Repair or remove the markers and retry; the file was left unchanged.`,
    );
  }

  const region = currentContent.slice(
    startIndex,
    endIndex + OPENWIKI_AGENTS_SNIPPET_END.length,
  );

  // Canonical block: leave the file untouched. Skip-write preserves mtime and
  // line endings and avoids a rewrite on every chat run.
  if (normalizeLineEndings(region) === normalizeLineEndings(snippet)) {
    return {
      agentsPath,
      originalContent: currentContent,
      nextContent: currentContent,
    };
  }

  // Non-canonical block: user content sits inside the managed region. Back it
  // up before the refresh replaces it, and say so out loud.
  const backupPath = `${agentsPath}${OPENWIKI_AGENTS_BACKUP_SUFFIX}`;
  const overwritingExisting = await pathExists(backupPath);
  return {
    agentsPath,
    originalContent: currentContent,
    nextContent: `${currentContent.slice(0, startIndex)}${snippet}${currentContent.slice(endIndex + OPENWIKI_AGENTS_SNIPPET_END.length)}`,
    backupContent: currentContent,
    warning: `OpenWiki: found content between the managed markers of ${path.basename(agentsPath)} that differs from the generated snippet; backup saved to ${backupPath}${overwritingExisting ? " (previous backup replaced)" : ""}. Move custom content outside the markers to keep it.`,
  };
}

function createCodeModeWorkflow(cronExpression: string): string {
  return `name: OpenWiki Update

on:
  workflow_dispatch:
  schedule:
    - cron: "${cronExpression}"

permissions:
  contents: write
  pull-requests: write

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4

      - name: Set up Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: "22"

      - name: Install OpenWiki
        # mermaid + jsdom are optional; they add high-fidelity validation of Mermaid diagrams. Remove if your wiki has none.
        run: npm install --global openwiki@${OPENWIKI_VERSION} mermaid@11.16.0 jsdom@29.1.1

      - name: Run OpenWiki
        run: openwiki code --update --print
        env:
          OPENWIKI_PROVIDER: openrouter
          OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}
          OPENWIKI_MODEL_ID: z-ai/glm-5.2
          # Required for the LangSmith connector's code-mode pull to authenticate.
          # For extra workspaces, add OPENWIKI_LANGSMITH_API_KEY_2, _3, ... as repo
          # secrets and env entries here.
          OPENWIKI_LANGSMITH_API_KEY: \${{ secrets.OPENWIKI_LANGSMITH_API_KEY }}
          # Optional: also trace this workflow's own OpenWiki run to LangSmith.
          LANGSMITH_API_KEY: \${{ secrets.LANGSMITH_API_KEY }}
          LANGCHAIN_PROJECT: openwiki
          LANGCHAIN_TRACING_V2: "true"

      - name: Create OpenWiki update pull request
        uses: peter-evans/create-pull-request@22a9089034f40e5a961c8808d113e2c98fb63676 # v7
        with:
          add-paths: |
            openwiki
            AGENTS.md
            CLAUDE.md
            AGENTS.md.openwiki.bak
            CLAUDE.md.openwiki.bak
            .github/workflows/openwiki-update.yml
          branch: openwiki/update
          commit-message: "docs: update OpenWiki"
          title: "docs: update OpenWiki"
          body: |
            Automated OpenWiki documentation update.

            This PR was generated by the scheduled OpenWiki workflow.
`;
}

function createCodeModeAgentsSnippet(): string {
  return `${OPENWIKI_AGENTS_SNIPPET_START}

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with \`openwiki/quickstart.md\`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

${OPENWIKI_AGENTS_SNIPPET_END}`;
}
