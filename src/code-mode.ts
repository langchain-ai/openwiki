import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isFileNotFoundError } from "./fs-errors.js";

const OPENWIKI_AGENTS_SNIPPET_START = "<!-- OPENWIKI:START -->";
const OPENWIKI_AGENTS_SNIPPET_END = "<!-- OPENWIKI:END -->";
const DEFAULT_CODE_MODE_CRON = "0 8 * * *";

// Root agent-instruction files OpenWiki keeps pointed at the generated wiki.
// Each is created when missing and refreshed in place when already present.
const CODE_MODE_AGENT_FILES = ["AGENTS.md", "CLAUDE.md"];

export async function ensureCodeModeRepoSetup(
  cwd: string,
  cronExpression = DEFAULT_CODE_MODE_CRON,
): Promise<void> {
  await writeCodeModeWorkflow(cwd, cronExpression);
  await writeCodeModeAgentSnippets(cwd);
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

async function writeCodeModeAgentSnippets(cwd: string): Promise<void> {
  const snippet = createCodeModeAgentsSnippet();

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

  const legacyScan = removeLegacyOpenWikiSections(currentContent);
  const content = legacyScan.content;

  const startIndex = content.indexOf(OPENWIKI_AGENTS_SNIPPET_START);
  const endIndex = content.indexOf(OPENWIKI_AGENTS_SNIPPET_END);

  let nextContent: string;
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    nextContent = `${content.slice(0, startIndex)}${snippet}${content.slice(endIndex + OPENWIKI_AGENTS_SNIPPET_END.length)}`;
  } else if (legacyScan.firstRemovalIndex !== null) {
    const before = content.slice(0, legacyScan.firstRemovalIndex);
    const after = content.slice(legacyScan.firstRemovalIndex);
    nextContent =
      after.trim().length > 0
        ? `${before}${snippet}\n\n${after}`
        : `${before.trimEnd()}${before.trim().length > 0 ? "\n\n" : ""}${snippet}\n`;
  } else {
    nextContent = `${content.trimEnd()}${content.trim().length > 0 ? "\n\n" : ""}${snippet}\n`;
  }

  await writeFile(agentsPath, nextContent, "utf8");
}

// Versions before the managed-block markers wrote a bare "## OpenWiki"
// section, so refreshes appended a second copy next to it instead of
// replacing it. Sections are treated as OpenWiki-owned only when they
// reference the generated wiki entrypoint; same-named user-authored
// sections are left alone.
const OPENWIKI_SECTION_SIGNATURE = "openwiki/quickstart.md";

function removeLegacyOpenWikiSections(content: string): {
  content: string;
  firstRemovalIndex: number | null;
} {
  const startMarkerIndex = content.indexOf(OPENWIKI_AGENTS_SNIPPET_START);
  const endMarkerIndex = content.indexOf(OPENWIKI_AGENTS_SNIPPET_END);
  const hasMarkedBlock =
    startMarkerIndex !== -1 && endMarkerIndex > startMarkerIndex;

  const headingPattern = /^## OpenWiki[ \t]*\r?$/gm;
  const removals: Array<{ start: number; end: number }> = [];

  for (
    let match = headingPattern.exec(content);
    match !== null;
    match = headingPattern.exec(content)
  ) {
    const sectionStart = match.index;
    const insideMarkedBlock =
      hasMarkedBlock &&
      sectionStart > startMarkerIndex &&
      sectionStart < endMarkerIndex;
    if (insideMarkedBlock) {
      continue;
    }

    const sectionEnd = findLegacySectionEnd(content, headingPattern.lastIndex);
    const section = content.slice(sectionStart, sectionEnd);
    if (!section.includes(OPENWIKI_SECTION_SIGNATURE)) {
      continue;
    }

    removals.push({ start: sectionStart, end: sectionEnd });
    headingPattern.lastIndex = sectionEnd;
  }

  if (removals.length === 0) {
    return { content, firstRemovalIndex: null };
  }

  let stripped = "";
  let cursor = 0;
  for (const removal of removals) {
    stripped += content.slice(cursor, removal.start);
    cursor = removal.end;
  }
  stripped += content.slice(cursor);

  return { content: stripped, firstRemovalIndex: removals[0].start };
}

function findLegacySectionEnd(content: string, fromIndex: number): number {
  const boundaryPattern = new RegExp(
    `^(?:#{1,2} |${OPENWIKI_AGENTS_SNIPPET_START})`,
    "m",
  );
  const boundaryOffset = content.slice(fromIndex).search(boundaryPattern);
  return boundaryOffset === -1 ? content.length : fromIndex + boundaryOffset;
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

function createCodeModeAgentsSnippet(): string {
  return `${OPENWIKI_AGENTS_SNIPPET_START}

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with \`openwiki/quickstart.md\`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

${OPENWIKI_AGENTS_SNIPPET_END}`;
}
