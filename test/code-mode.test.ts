import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ensureCodeModeRepoSetup } from "../src/code-mode.ts";

const SNIPPET_START = "<!-- OPENWIKI:START -->";
const SNIPPET_END = "<!-- OPENWIKI:END -->";

const tempRepos: string[] = [];

async function createTempRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-code-mode-"));
  tempRepos.push(repo);
  return repo;
}

async function readIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

afterEach(async () => {
  await Promise.all(
    tempRepos
      .splice(0)
      .map((repo) => rm(repo, { force: true, recursive: true })),
  );
});

describe("ensureCodeModeRepoSetup agent files", () => {
  test("creates both AGENTS.md and CLAUDE.md when neither exists", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo);

    for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
      const content = await readIfPresent(path.join(repo, fileName));
      expect(content, `${fileName} should be created`).not.toBeNull();
      expect(content).toContain(SNIPPET_START);
      expect(content).toContain(SNIPPET_END);
      expect(content).toContain("## OpenWiki");
    }
  });

  test("refreshes the OpenWiki block in place and preserves surrounding content", async () => {
    const repo = await createTempRepo();
    const existing = `# My Project

Hand-written guidance for coding agents.

${SNIPPET_START}
stale OpenWiki content
${SNIPPET_END}

Trailing notes that must survive.
`;
    await writeFile(path.join(repo, "CLAUDE.md"), existing, "utf8");

    await ensureCodeModeRepoSetup(repo);

    const content = await readIfPresent(path.join(repo, "CLAUDE.md"));
    expect(content).toContain("# My Project");
    expect(content).toContain("Hand-written guidance for coding agents.");
    expect(content).toContain("Trailing notes that must survive.");
    expect(content).not.toContain("stale OpenWiki content");
    // Exactly one managed block after a refresh.
    expect(content?.match(new RegExp(SNIPPET_START, "g"))).toHaveLength(1);
  });

  test("appends the block to an existing file without markers, keeping content", async () => {
    const repo = await createTempRepo();
    const existing = "# Existing AGENTS\n\nDo not lose this line.\n";
    await writeFile(path.join(repo, "AGENTS.md"), existing, "utf8");

    await ensureCodeModeRepoSetup(repo);

    const content = await readIfPresent(path.join(repo, "AGENTS.md"));
    expect(content).toContain("Do not lose this line.");
    expect(content).toContain(SNIPPET_START);
    // Appended after the original content, not prepended over it.
    expect(content?.indexOf("Do not lose this line.")).toBeLessThan(
      content?.indexOf(SNIPPET_START) ?? -1,
    );
  });

  test("is idempotent across repeated runs", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo);
    const first = await readIfPresent(path.join(repo, "CLAUDE.md"));
    await ensureCodeModeRepoSetup(repo);
    const second = await readIfPresent(path.join(repo, "CLAUDE.md"));

    expect(second).toEqual(first);
  });
});

describe("ensureCodeModeRepoSetup workflow", () => {
  test("creates workflow when it does not exist", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo);

    const workflow = await readIfPresent(
      path.join(repo, ".github", "workflows", "openwiki-update.yml"),
    );
    expect(workflow).not.toBeNull();
    expect(workflow).toContain("add-paths: |");
    for (const managedPath of [
      "openwiki",
      "AGENTS.md",
      "CLAUDE.md",
      ".github/workflows/openwiki-update.yml",
    ]) {
      expect(workflow).toContain(managedPath);
    }
  });

  test("preserves existing customized workflow and does not overwrite", async () => {
    const repo = await createTempRepo();
    const customWorkflow = `name: OpenWiki Update

on:
  workflow_dispatch:
  schedule:
    - cron: "0 2 * * 1"

permissions:
  contents: write
  pull-requests: write

jobs:
  update:
    if: github.repository == 'my-org/my-repo'
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4
        with:
          persist-credentials: true

      - name: Run OpenWiki
        run: openwiki code --update --print
        env:
          OPENWIKI_PROVIDER: anthropic
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          OPENWIKI_MODEL_ID: claude-sonnet-4-20250514
`;
    const workflowDir = path.join(repo, ".github", "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      path.join(workflowDir, "openwiki-update.yml"),
      customWorkflow,
      "utf8",
    );

    await ensureCodeModeRepoSetup(repo);

    const workflow = await readIfPresent(
      path.join(workflowDir, "openwiki-update.yml"),
    );
    // Must preserve the user's customizations, not overwrite with defaults.
    expect(workflow).toBe(customWorkflow);
    expect(workflow).toContain('cron: "0 2 * * 1"');
    expect(workflow).toContain("if: github.repository == 'my-org/my-repo'");
    expect(workflow).toContain("OPENWIKI_PROVIDER: anthropic");
    expect(workflow).toContain("claude-sonnet-4-20250514");
    expect(workflow).toContain("persist-credentials: true");
  });

  test("pins the openwiki install to a specific version, never unpinned", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo);

    const workflow = await readIfPresent(
      path.join(repo, ".github", "workflows", "openwiki-update.yml"),
    );
    // Installing an unpinned package in a privileged CI context is a supply-chain
    // risk; the generated workflow must pin openwiki to the shipping version.
    expect(workflow).toMatch(/npm install --global openwiki@\d+\.\d+\.\d+ /u);
    expect(workflow).not.toMatch(/--global openwiki(?![@\d])/u);
  });

  test("is idempotent across repeated runs for workflow", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo);
    const first = await readIfPresent(
      path.join(repo, ".github", "workflows", "openwiki-update.yml"),
    );
    await ensureCodeModeRepoSetup(repo);
    const second = await readIfPresent(
      path.join(repo, ".github", "workflows", "openwiki-update.yml"),
    );

    expect(second).toEqual(first);
  });
});
