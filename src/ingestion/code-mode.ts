import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BEDROCK_AWS_SESSION_TOKEN_ENV_KEY,
  getProviderAuthMethod,
  getProviderConfig,
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
  const claudeSnippet = createCodeModeClaudeSnippet();
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
      writeFile(agentsPath, nextContent, "utf8"),
    ),
  );
}

async function prepareCodeModeAgentSnippet(
  agentsPath: string,
  snippet: string,
): Promise<{ agentsPath: string; nextContent: string }> {
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

  return {
    agentsPath,
    nextContent: `${currentContent.slice(0, startIndex)}${snippet}${currentContent.slice(endIndex + OPENWIKI_AGENTS_SNIPPET_END.length)}`,
  };
}

/**
 * The provider inputs for the reusable action, derived from the provider the
 * operator configured during setup. A fixed provider block here authenticates
 * only the default setup: every other one silently ships a workflow whose first
 * scheduled run fails on a credential the repo never had.
 *
 * Only what the provider config actually pins down is emitted. Secrets go
 * through `secrets.`, non-sensitive settings (endpoint, project, region)
 * through `vars.`, so neither has to be reverse-engineered from a stack trace.
 */
function createWorkflowProviderInputs(env: NodeJS.ProcessEnv): string {
  const provider = resolveConfiguredProvider(env);
  const config = getProviderConfig(provider);
  const lines = [`provider: ${provider}`];

  if (getProviderAuthMethod(provider) === "oauth") {
    // The stored access token is short-lived and refreshed in place, so
    // pinning it as a repo secret would break on the first rotation.
    lines.push(
      `# ${config.label} authenticates through a browser login, which has no`,
      "# unattended equivalent. Supply CI credentials for it yourself.",
    );
  } else if (config.apiKeyEnvKey !== undefined) {
    lines.push(`api-key: \${{ secrets.${config.apiKeyEnvKey} }}`);
    if (config.secretKeyEnvKey !== undefined) {
      lines.push(`secret-key: \${{ secrets.${config.secretKeyEnvKey} }}`);
    }
  }

  if (provider === "bedrock") {
    lines.push(
      `session-token: \${{ secrets.${BEDROCK_AWS_SESSION_TOKEN_ENV_KEY} }}`,
    );
  }
  if (config.baseUrlEnvKey !== undefined) {
    lines.push(`base-url: \${{ vars.${config.baseUrlEnvKey} }}`);
  }
  if (config.projectEnvKey !== undefined) {
    lines.push(`project: \${{ vars.${config.projectEnvKey} }}`);
  }
  if (config.locationEnvKey !== undefined) {
    lines.push(`location: \${{ vars.${config.locationEnvKey} }}`);
  }
  if (config.requiresRegion && config.regionEnvKey !== undefined) {
    lines.push(`region: \${{ vars.${config.regionEnvKey} }}`);
  }

  // Bedrock ships no preset model list because entitlements are account- and
  // region-specific, so there is nothing safe to suggest and the line is left out.
  const modelId =
    env[OPENWIKI_MODEL_ID_ENV_KEY]?.trim() || config.modelOptions[0]?.id;
  if (modelId !== undefined) {
    // Quoted because model IDs are not all plain YAML scalars: Cloudflare
    // Workers AI IDs lead with "@", a reserved indicator that fails to parse.
    lines.push(`model-id: ${JSON.stringify(modelId)}`);
  }

  // Not part of the provider config because it is a transport override rather
  // than a credential, but it has to survive into the scheduled run: a gateway
  // that only serves SSE would otherwise return empty content unattended and
  // commit a blank wiki. Emitted only when the author opted in locally.
  if (resolveOpenAiCompatibleStreaming(env)) {
    lines.push(`openai-compatible-streaming: "true"`);
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
      - name: Update OpenWiki
        uses: langchain-ai/openwiki@v${OPENWIKI_VERSION}
        with:
          ${createWorkflowProviderInputs(env)}
          openwiki-langsmith-api-key: \${{ secrets.OPENWIKI_LANGSMITH_API_KEY }}
          langsmith-api-key: \${{ secrets.LANGSMITH_API_KEY }}
          langchain-project: openwiki
          langchain-tracing-v2: "true"
`;
}

function createCodeModeAgentsSnippet(): string {
  return `${OPENWIKI_AGENTS_SNIPPET_START}

## OpenWiki

This repository has a generated \`openwiki/\` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

${OPENWIKI_AGENTS_SNIPPET_END}`;
}

/**
 * The snippet placed inside CLAUDE.md's managed block. It is intentionally
 * minimal -- a single pointer to AGENTS.md -- so that one file remains the
 * canonical source of agent instructions while Claude Code still has a file
 * it reads at startup.
 */
function createCodeModeClaudeSnippet(): string {
  return `${OPENWIKI_AGENTS_SNIPPET_START}

## OpenWiki

See [AGENTS.md](AGENTS.md) for OpenWiki agent instructions.

${OPENWIKI_AGENTS_SNIPPET_END}`;
}
