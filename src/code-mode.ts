import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isFileNotFoundError } from "./fs-errors.js";

const execFileAsync = promisify(execFile);

const OPENWIKI_AGENTS_SNIPPET_START = "<!-- OPENWIKI:START -->";
const OPENWIKI_AGENTS_SNIPPET_END = "<!-- OPENWIKI:END -->";
const DEFAULT_CODE_MODE_CRON = "0 8 * * *";

// Which CI host OpenWiki tailors its generated artifacts to. Only "github"
// gets a committed CI workflow (GitHub Actions); the others ship as examples/
// the user wires up themselves, so we just keep the agent-file wording honest.
type CiProvider = "github" | "gitlab" | "bitbucket" | "none";

// Environment override for provider detection, useful for self-hosted hosts
// whose remote URL doesn't advertise the provider, or to opt out entirely
// (e.g. `OPENWIKI_CI_PROVIDER=none` in a CI pipeline that manages its own PRs).
const CI_PROVIDER_ENV_KEY = "OPENWIKI_CI_PROVIDER";

// Root agent-instruction files OpenWiki keeps pointed at the generated wiki.
// Each is created when missing and refreshed in place when already present.
const CODE_MODE_AGENT_FILES = ["AGENTS.md", "CLAUDE.md"];

export async function ensureCodeModeRepoSetup(
  cwd: string,
  cronExpression = DEFAULT_CODE_MODE_CRON,
): Promise<void> {
  const provider = await detectCiProvider(cwd);

  if (provider === "github") {
    await writeCodeModeWorkflow(cwd, cronExpression);
  }

  await writeCodeModeAgentSnippets(cwd, provider);
}

async function detectCiProvider(cwd: string): Promise<CiProvider> {
  const override = normalizeCiProvider(process.env[CI_PROVIDER_ENV_KEY]);
  if (override) {
    return override;
  }

  return classifyRemoteHost(await readGitRemoteUrl(cwd));
}

function normalizeCiProvider(value: string | undefined): CiProvider | null {
  switch (value?.trim().toLowerCase()) {
    case "github":
      return "github";
    case "gitlab":
      return "gitlab";
    case "bitbucket":
      return "bitbucket";
    case "none":
      return "none";
    default:
      return null;
  }
}

// Reads the repo's push/fetch remote URL so we can infer the git host. Prefers
// `origin`, falling back to whatever remote exists. Returns null when there is
// no git repo or no remote configured.
async function readGitRemoteUrl(cwd: string): Promise<string | null> {
  const originUrl = await runGitQuietly(cwd, ["remote", "get-url", "origin"]);
  if (originUrl) {
    return originUrl;
  }

  const remotes = await runGitQuietly(cwd, ["remote"]);
  const firstRemote = remotes
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstRemote) {
    return null;
  }

  return runGitQuietly(cwd, ["remote", "get-url", firstRemote]);
}

async function runGitQuietly(
  cwd: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // No git binary, not a repo, or no such remote — treat as undetectable.
    return null;
  }
}

// Classifies a git remote URL by host. Enterprise/self-hosted GitHub and GitLab
// instances typically keep the provider name in their hostname, so a substring
// match is deliberate. Unknown hosts (and missing remotes) fall back to GitHub
// to preserve the historical default; use OPENWIKI_CI_PROVIDER to override.
function classifyRemoteHost(remoteUrl: string | null): CiProvider {
  if (!remoteUrl) {
    return "github";
  }

  const lower = remoteUrl.toLowerCase();
  if (lower.includes("gitlab")) {
    return "gitlab";
  }
  if (lower.includes("bitbucket")) {
    return "bitbucket";
  }

  return "github";
}

async function writeCodeModeWorkflow(
  cwd: string,
  cronExpression: string,
): Promise<void> {
  const workflowPath = path.join(
    cwd,
    ".github",
    "workflows",
    "openwiki-update.yml",
  );
  await mkdir(path.dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, createCodeModeWorkflow(cronExpression), "utf8");
}

async function writeCodeModeAgentSnippets(
  cwd: string,
  provider: CiProvider,
): Promise<void> {
  const snippet = createCodeModeAgentsSnippet(provider);

  await Promise.all(
    CODE_MODE_AGENT_FILES.map((fileName) =>
      writeCodeModeAgentSnippet(path.join(cwd, fileName), snippet),
    ),
  );
}

async function writeCodeModeAgentSnippet(
  agentsPath: string,
  snippet: string,
): Promise<void> {
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
  const nextContent =
    startIndex !== -1 && endIndex !== -1 && endIndex > startIndex
      ? `${currentContent.slice(0, startIndex)}${snippet}${currentContent.slice(endIndex + OPENWIKI_AGENTS_SNIPPET_END.length)}`
      : `${currentContent.trimEnd()}${currentContent.trim().length > 0 ? "\n\n" : ""}${snippet}\n`;

  await writeFile(agentsPath, nextContent, "utf8");
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
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Install OpenWiki
        run: npm install --global openwiki

      - name: Run OpenWiki
        run: openwiki code --update --print
        env:
          OPENWIKI_PROVIDER: openrouter
          OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}
          OPENWIKI_MODEL_ID: z-ai/glm-5.2
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
            .github/workflows/openwiki-update.yml
          branch: openwiki/update
          commit-message: "docs: update OpenWiki"
          title: "docs: update OpenWiki"
          body: |
            Automated OpenWiki documentation update.

            This PR was generated by the scheduled OpenWiki workflow.
`;
}

function createCodeModeAgentsSnippet(provider: CiProvider): string {
  return `${OPENWIKI_AGENTS_SNIPPET_START}

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with \`openwiki/quickstart.md\`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The ${describeCodeModeUpdateJob(provider)} refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

${OPENWIKI_AGENTS_SNIPPET_END}`;
}

// Provider-aware phrasing for the OPENWIKI agent-file block so the sentence is
// accurate on non-GitHub hosts instead of always claiming a GitHub Actions run.
function describeCodeModeUpdateJob(provider: CiProvider): string {
  switch (provider) {
    case "github":
      return "scheduled OpenWiki GitHub Actions workflow";
    case "gitlab":
      return "scheduled OpenWiki GitLab pipeline";
    case "bitbucket":
      return "scheduled OpenWiki Bitbucket pipeline";
    case "none":
      return "scheduled OpenWiki update job";
  }
}
