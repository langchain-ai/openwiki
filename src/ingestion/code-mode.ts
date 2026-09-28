import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getProviderAuthMethod,
  getProviderConfig,
  OPENAI_COMPATIBLE_STREAMING_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_VERSION,
  resolveConfiguredProvider,
  resolveOpenAiCompatibleStreaming,
} from "../config/constants.js";
import { isFileNotFoundError } from "../platform/fs-errors.js";
import { createConnectorRegistry } from "../connectors/registry.js";
import { UPDATE_METADATA_PATH } from "../config/constants.js";
import { createConnectorSynthesisGuidance } from "./ingestion.js";
import type { OpenWikiRunEvent } from "../agent/types.js";

const OPENWIKI_AGENTS_SNIPPET_START = "<!-- OPENWIKI:START -->";
const OPENWIKI_AGENTS_SNIPPET_END = "<!-- OPENWIKI:END -->";
const DEFAULT_CODE_MODE_CRON = "0 8 * * *";

// The heading and opening sentence every pre-marker (0.0.x) release wrote
// straight into AGENTS.md / CLAUDE.md, before the managed markers existed. A
// bare `## OpenWiki` heading only counts as that legacy section when the next
// non-blank line is exactly this sentence, so a section someone wrote by hand
// that merely shares the heading is never touched.
const OPENWIKI_LEGACY_HEADING = "## OpenWiki";
const OPENWIKI_LEGACY_SENTENCE =
  "This repository has documentation located in the /openwiki directory.";
// The remaining lines of that template, matched exactly. Matching a prefix here
// would delete a line a user appended text to (their edit and everything below
// it), so every template line stops the removal unless it is untouched.
const OPENWIKI_LEGACY_TEMPLATE_LINES = [
  "Start here:",
  "- [OpenWiki quickstart](openwiki/quickstart.md)",
  "OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.",
  "When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.",
];

// Root agent-instruction files OpenWiki keeps pointed at the generated wiki.
// Each is created when missing and refreshed in place when already present.
const CODE_MODE_AGENT_FILES = ["AGENTS.md", "CLAUDE.md"];
const CLAUDE_AGENTS_IMPORT = "@AGENTS.md";

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
   * Environment the generated workflow's provider block is derived from.
   * Defaults to `process.env`, which by this point holds the credentials setup
   * resolved for this run.
   */
  env?: NodeJS.ProcessEnv;
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
      options.env ?? process.env,
    );
  }
  await writeCodeModeAgentSnippets(cwd);
}

/**
 * Create the scheduled-update workflow file only when it is missing. An existing
 * file is preserved verbatim so repo-specific customizations survive repeated
 * runs; a plain overwrite would silently strip them.
 */
async function ensureCodeModeWorkflow(
  cwd: string,
  cronExpression: string,
  env: NodeJS.ProcessEnv,
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
  await writeFile(
    workflowPath,
    createCodeModeWorkflow(cronExpression, env),
    "utf8",
  );
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
  onEvent?.({ text, type: "text" });
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

async function writeCodeModeAgentSnippets(cwd: string): Promise<void> {
  const agentsSnippet = createCodeModeAgentsSnippet();
  // Some repositories make CLAUDE.md a link to AGENTS.md. There the import
  // would point the file at itself, so the block carries the instructions
  // instead of referring to them.
  const claudeSnippet = (await resolvesToSameFile(
    path.join(cwd, "AGENTS.md"),
    path.join(cwd, "CLAUDE.md"),
  ))
    ? agentsSnippet
    : createCodeModeClaudeSnippet();
  const snippetByFile: Record<string, string> = {
    "AGENTS.md": agentsSnippet,
    "CLAUDE.md": claudeSnippet,
  };
  // Prepare and validate both files before writing either one. If one file has
  // malformed markers, setup fails without partially refreshing its sibling.
  const updates = await Promise.all(
    CODE_MODE_AGENT_FILES.map((fileName) =>
      prepareCodeModeAgentSnippet(
        path.join(cwd, fileName),
        snippetByFile[fileName] ?? agentsSnippet,
      ),
    ),
  );

  await Promise.all(
    updates.map(({ agentsPath, nextContent }) =>
      nextContent === undefined
        ? Promise.resolve()
        : writeFile(agentsPath, nextContent, "utf8"),
    ),
  );
}

async function prepareCodeModeAgentSnippet(
  agentsPath: string,
  snippet: string,
): Promise<{ agentsPath: string; nextContent: string | undefined }> {
  let currentContent = "";

  try {
    currentContent = await readFile(agentsPath, "utf8");
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  const isClaude = path.basename(agentsPath) === "CLAUDE.md";

  // A CLAUDE.md that is nothing but the AGENTS.md import is already canonical:
  // leave it byte-for-byte so we never rewrite a file that has nothing to fix.
  if (isClaude && currentContent.trim() === CLAUDE_AGENTS_IMPORT) {
    return { agentsPath, nextContent: undefined };
  }

  // Strip any legacy pre-marker `## OpenWiki` sections before deciding where the
  // managed block goes. Without this, a file that a 0.0.x release wrote a bare
  // section into keeps that section forever: no markers are found, a fresh block
  // is appended, and every later run only refreshes the block, so the old
  // section and the new block sit side by side as two `## OpenWiki` headings.
  const legacySections = findLegacyOpenWikiSections(currentContent);
  const withoutLegacy = removeRanges(currentContent, legacySections);

  // Marker validation runs on the content we are actually about to write, i.e.
  // after the legacy section has been removed, not on the original.
  const startIndex = withoutLegacy.indexOf(OPENWIKI_AGENTS_SNIPPET_START);
  const endIndex = withoutLegacy.indexOf(OPENWIKI_AGENTS_SNIPPET_END);
  const hasNoMarkers = startIndex === -1 && endIndex === -1;

  if (hasNoMarkers) {
    // Removing a legacy section from an import-style CLAUDE.md can leave only
    // the AGENTS.md import behind. Keep just that import rather than adding a
    // managed block, since AGENTS.md already carries the instructions.
    if (isClaude && withoutLegacy.trim() === CLAUDE_AGENTS_IMPORT) {
      return { agentsPath, nextContent: `${CLAUDE_AGENTS_IMPORT}\n` };
    }

    if (legacySections.length === 0) {
      // No markers and no legacy section: append a fresh block, the original
      // behavior for a file OpenWiki has not managed before.
      return {
        agentsPath,
        nextContent: `${currentContent.trimEnd()}${currentContent.trim().length > 0 ? "\n\n" : ""}${snippet}\n`,
      };
    }

    // Put the managed block where the legacy section was, so the file keeps its
    // shape instead of the block jumping to the end. Any additional legacy
    // sections are removed; content the user wrote below survives untouched.
    const anchor = legacySections[0].startChar;
    const before = withoutLegacy.slice(0, anchor).replace(/\s+$/u, "");
    const after = withoutLegacy.slice(anchor).replace(/^[\r\n]+/u, "");
    const body = [before, snippet, after]
      .filter((part) => part.length > 0)
      .join("\n\n");
    return { agentsPath, nextContent: `${body.replace(/\s+$/u, "")}\n` };
  }

  const hasOneOrderedPair =
    startIndex !== -1 &&
    endIndex > startIndex &&
    startIndex === withoutLegacy.lastIndexOf(OPENWIKI_AGENTS_SNIPPET_START) &&
    endIndex === withoutLegacy.lastIndexOf(OPENWIKI_AGENTS_SNIPPET_END);

  if (!hasOneOrderedPair) {
    throw new Error(
      `Cannot update ${path.basename(agentsPath)} because its OpenWiki managed markers are malformed or duplicated. Expected either no markers or exactly one ${OPENWIKI_AGENTS_SNIPPET_START} marker followed by one ${OPENWIKI_AGENTS_SNIPPET_END} marker. Repair or remove the markers and retry; the file was left unchanged.`,
    );
  }

  return {
    agentsPath,
    nextContent: `${withoutLegacy.slice(0, startIndex)}${snippet}${withoutLegacy.slice(endIndex + OPENWIKI_AGENTS_SNIPPET_END.length)}`,
  };
}

/**
 * Character ranges of every legacy pre-marker `## OpenWiki` section in the file.
 *
 * A heading only qualifies when its next non-blank line is the released template
 * sentence; a same-named section someone wrote by hand, or a heading quoted
 * inside a fenced code block, is left alone. Each range covers the heading and
 * the run of known template lines beneath it (the sentence, "Start here:", the
 * quickstart link, the "OpenWiki includes…" and "When working…" lines, and the
 * blank lines between them), stopping at the first line that is not one of those
 * so hand-edited content underneath the old section survives.
 */
function findLegacyOpenWikiSections(
  content: string,
): Array<{ startChar: number; endChar: number }> {
  const lines = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const offsets: number[] = [];
  let running = 0;
  for (const line of lines) {
    offsets.push(running);
    running += line.length;
  }

  const bodyOf = (line: string): string => line.replace(/\r?\n$/u, "");

  const sections: Array<{ startChar: number; endChar: number }> = [];
  // An unterminated opening fence leaves `fence` set to the end of the file, so
  // any `## OpenWiki` heading after it is treated as fenced and skipped. That is
  // deliberately conservative: it can miss a real legacy section, but it never
  // deletes content that only looked fenced.
  let fence: { char: string; length: number } | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const body = bodyOf(lines[i]);
    const marker = parseFenceMarker(body);
    if (fence !== undefined) {
      // Only a fence of the same character and at least the opener's length,
      // with no info string, closes it (CommonMark). A `~~~` line inside a
      // ``` block therefore does not toggle, so the quoted snippet stays quoted.
      if (
        marker !== undefined &&
        marker.char === fence.char &&
        marker.length >= fence.length &&
        marker.info.trim() === ""
      ) {
        fence = undefined;
      }
      continue;
    }
    if (marker !== undefined) {
      fence = { char: marker.char, length: marker.length };
      continue;
    }
    // The released template started at column zero. Do not trim: four spaces
    // start an indented Markdown code block, which may document this snippet.
    if (body !== OPENWIKI_LEGACY_HEADING) {
      continue;
    }

    let next = i + 1;
    while (next < lines.length && bodyOf(lines[next]) === "") {
      next += 1;
    }
    if (
      next >= lines.length ||
      bodyOf(lines[next]) !== OPENWIKI_LEGACY_SENTENCE
    ) {
      continue;
    }

    let end = i + 1;
    while (end < lines.length && isLegacyTemplateLine(bodyOf(lines[end]))) {
      end += 1;
    }
    sections.push({
      startChar: offsets[i],
      endChar: end < lines.length ? offsets[end] : content.length,
    });
    i = end - 1;
  }

  return sections;
}

/**
 * Whether a trimmed line is one of the known lines from the legacy template,
 * i.e. safe to remove as part of the old section. Everything else stops the
 * removal, which is what keeps hand-edited content beneath the section intact.
 */
function isLegacyTemplateLine(line: string): boolean {
  return (
    line === "" ||
    line === OPENWIKI_LEGACY_SENTENCE ||
    OPENWIKI_LEGACY_TEMPLATE_LINES.includes(line)
  );
}

/**
 * Parse a Markdown code-fence marker from a line: a run of at least three
 * backticks or tildes, optionally indented, with whatever follows it as the
 * info string. Returns undefined for any other line.
 */
function parseFenceMarker(
  body: string,
): { char: string; length: number; info: string } | undefined {
  const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(body);
  if (match === null) {
    return undefined;
  }
  return { char: match[1][0], length: match[1].length, info: match[2] };
}

/** Splice a set of character ranges out of a string, highest offset first. */
function removeRanges(
  content: string,
  ranges: ReadonlyArray<{ startChar: number; endChar: number }>,
): string {
  let result = content;
  for (const range of [...ranges].sort((a, b) => b.startChar - a.startChar)) {
    result = result.slice(0, range.startChar) + result.slice(range.endChar);
  }
  return result;
}

/**
 * The provider half of the generated workflow's `env:` block, derived from the
 * provider the operator configured during setup. A fixed provider block here
 * authenticates only the default setup: every other one silently ships a
 * workflow whose first scheduled run fails on a credential the repo never had.
 *
 * Only what the provider config actually pins down is emitted. Secrets go
 * through `secrets.`, non-sensitive settings (endpoint, project, region)
 * through `vars.`, so neither has to be reverse-engineered from a stack trace.
 */
function createWorkflowProviderEnv(env: NodeJS.ProcessEnv): string {
  const provider = resolveConfiguredProvider(env);
  const config = getProviderConfig(provider);
  const lines = [`OPENWIKI_PROVIDER: ${provider}`];

  if (getProviderAuthMethod(provider) === "oauth") {
    // The stored access token is short-lived and refreshed in place, so
    // pinning it as a repo secret would break on the first rotation.
    lines.push(
      `# ${config.label} authenticates through a browser login, which has no`,
      "# unattended equivalent. Supply CI credentials for it yourself.",
    );
  } else if (config.apiKeyEnvKey !== undefined) {
    lines.push(
      `${config.apiKeyEnvKey}: \${{ secrets.${config.apiKeyEnvKey} }}`,
    );
    if (config.secretKeyEnvKey !== undefined) {
      lines.push(
        `${config.secretKeyEnvKey}: \${{ secrets.${config.secretKeyEnvKey} }}`,
      );
    }
  }

  if (config.requiresBaseUrl && config.baseUrlEnvKey !== undefined) {
    lines.push(`${config.baseUrlEnvKey}: \${{ vars.${config.baseUrlEnvKey} }}`);
  }
  if (config.projectEnvKey !== undefined) {
    lines.push(`${config.projectEnvKey}: \${{ vars.${config.projectEnvKey} }}`);
  }
  if (config.requiresRegion && config.regionEnvKey !== undefined) {
    lines.push(`${config.regionEnvKey}: \${{ vars.${config.regionEnvKey} }}`);
  }

  // Bedrock ships no preset model list because entitlements are account- and
  // region-specific, so there is nothing safe to suggest and the line is left out.
  const modelId =
    env[OPENWIKI_MODEL_ID_ENV_KEY]?.trim() || config.modelOptions[0]?.id;
  if (modelId !== undefined) {
    // Quoted because model IDs are not all plain YAML scalars: Cloudflare
    // Workers AI IDs lead with "@", a reserved indicator that fails to parse.
    lines.push(`${OPENWIKI_MODEL_ID_ENV_KEY}: ${JSON.stringify(modelId)}`);
  }

  // Not part of the provider config because it is a transport override rather
  // than a credential, but it has to survive into the scheduled run: a gateway
  // that only serves SSE would otherwise return empty content unattended and
  // commit a blank wiki. Emitted only when the author opted in locally.
  if (resolveOpenAiCompatibleStreaming(env)) {
    lines.push(`${OPENAI_COMPATIBLE_STREAMING_ENV_KEY}: "true"`);
  }

  return lines.join("\n          ");
}

function createCodeModeWorkflow(
  cronExpression: string,
  env: NodeJS.ProcessEnv,
): string {
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
        with:
          # Full history so \`openwiki code --update\` can diff HEAD against the
          # commit it last documented; a shallow clone hides that commit and the
          # update runs against an empty change summary.
          fetch-depth: 0

      - name: Set up Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: "22"

      - name: Install OpenWiki
        # mermaid + jsdom are optional; they add high-fidelity validation of Mermaid diagrams. Remove if your wiki has none.
        run: npm install --global openwiki@${OPENWIKI_VERSION} mermaid@11.16.0 jsdom@29.1.1

      - name: Run OpenWiki
        id: openwiki
        continue-on-error: true
        run: openwiki code --update --print
        env:
          ${createWorkflowProviderEnv(env)}
          # Required for the LangSmith connector's code-mode pull to authenticate.
          # For extra workspaces, add OPENWIKI_LANGSMITH_API_KEY_2, _3, ... as repo
          # secrets and env entries here.
          OPENWIKI_LANGSMITH_API_KEY: \${{ secrets.OPENWIKI_LANGSMITH_API_KEY }}
          # Optional: also trace this workflow's own OpenWiki run to LangSmith.
          LANGSMITH_API_KEY: \${{ secrets.LANGSMITH_API_KEY }}
          LANGCHAIN_PROJECT: openwiki
          LANGCHAIN_TRACING_V2: "true"

      - name: Remove transient OpenWiki run state
        if: \${{ !cancelled() }}
        run: rm -f -- openwiki/.run.json

      - name: Create OpenWiki update pull request
        id: create-pr
        if: \${{ !cancelled() }}
        uses: peter-evans/create-pull-request@22a9089034f40e5a961c8808d113e2c98fb63676 # v7
        with:
          add-paths: |
            openwiki
            AGENTS.md
            CLAUDE.md
            .github/workflows/openwiki-update.yml
          branch: openwiki/update
          commit-message: "docs: update OpenWiki"
          title: "docs: update OpenWiki"
          body: |
            Automated OpenWiki documentation update.

            OpenWiki result: \${{ steps.openwiki.outcome }}

            When the result is \`failure\`, this PR intentionally preserves only the
            pages completed before the failure. Merge it to make that progress the
            baseline for the next scheduled run.

      - name: Annotate OpenWiki update pull request
        if: \${{ !cancelled() && steps.create-pr.outputs.pull-request-url != '' }}
        run: echo "::notice title=OpenWiki update pull request::\${{ steps.create-pr.outputs.pull-request-url }}"

      - name: Propagate OpenWiki failure
        if: \${{ steps.openwiki.outcome == 'failure' }}
        run: exit 1
`;
}

/**
 * Creates the repository-agent guidance managed by OpenWiki.
 *
 * Retrieval tools take precedence over eagerly loading the local quickstart so
 * linked workspaces remain discoverable and context stays progressive.
 *
 * @returns Complete fenced AGENTS.md instruction block.
 */
function createCodeModeAgentsSnippet(): string {
  return `${OPENWIKI_AGENTS_SNIPPET_START}

## OpenWiki

This repository has a generated \`openwiki/\` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use \`openwiki_search\` for just-in-time context and \`openwiki_read\` for the relevant complete sections. If search returns \`workspace_required\`, ask which listed workspace to use and retry with its ID.
- Use \`openwiki_list_workspaces\` or \`openwiki_list_wikis\` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read \`openwiki/quickstart.md\` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

${OPENWIKI_AGENTS_SNIPPET_END}`;
}

/**
 * The snippet placed inside CLAUDE.md's managed block. It is intentionally
 * minimal -- a single import of AGENTS.md -- so that one file remains the
 * canonical source of agent instructions while Claude Code still has a file
 * it reads at startup.
 *
 * The import has to be `@AGENTS.md` rather than a Markdown link: Claude Code
 * expands only its own `@path` syntax, and it falls back to reading AGENTS.md
 * itself only when no CLAUDE.md sits beside it -- which, once this snippet is
 * written, is never. A link leaves the block inert.
 */
function createCodeModeClaudeSnippet(): string {
  return `${OPENWIKI_AGENTS_SNIPPET_START}

## OpenWiki

@AGENTS.md

${OPENWIKI_AGENTS_SNIPPET_END}`;
}

/**
 * Whether two paths are the same file on disk, following symlinks. Inode 0 is
 * treated as unknown because some Windows filesystems report it for every
 * file, which would otherwise make unrelated paths compare equal.
 */
async function resolvesToSameFile(
  first: string,
  second: string,
): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([stat(first), stat(second)]);
    return a.ino !== 0 && a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}
