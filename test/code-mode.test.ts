import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { ensureCodeModeRepoSetup } from "../src/code-mode.ts";

const execFileAsync = promisify(execFile);

const SNIPPET_START = "<!-- OPENWIKI:START -->";
const SNIPPET_END = "<!-- OPENWIKI:END -->";

const CI_PROVIDER_ENV_KEY = "OPENWIKI_CI_PROVIDER";

const tempRepos: string[] = [];

async function createTempRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-code-mode-"));
  tempRepos.push(repo);
  return repo;
}

const WORKFLOW_RELATIVE_PATH = path.join(
  ".github",
  "workflows",
  "openwiki-update.yml",
);

async function withCiProvider(
  value: string,
  run: () => Promise<void>,
): Promise<void> {
  const previous = process.env[CI_PROVIDER_ENV_KEY];
  process.env[CI_PROVIDER_ENV_KEY] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[CI_PROVIDER_ENV_KEY];
    } else {
      process.env[CI_PROVIDER_ENV_KEY] = previous;
    }
  }
}

async function initGitRepoWithRemote(
  repo: string,
  remoteUrl: string,
): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["remote", "add", "origin", remoteUrl], {
    cwd: repo,
  });
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
  test("generated PR includes agent files and the workflow in add-paths", async () => {
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

  test("defaults to GitHub wording and workflow when no git remote exists", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo);

    const workflow = await readIfPresent(
      path.join(repo, WORKFLOW_RELATIVE_PATH),
    );
    expect(
      workflow,
      "GitHub workflow should be written by default",
    ).not.toBeNull();

    const claude = await readIfPresent(path.join(repo, "CLAUDE.md"));
    expect(claude).toContain(
      "scheduled OpenWiki GitHub Actions workflow refreshes",
    );
  });
});

describe("ensureCodeModeRepoSetup provider awareness", () => {
  test.each([
    {
      provider: "gitlab",
      wording: "scheduled OpenWiki GitLab pipeline refreshes",
    },
    {
      provider: "bitbucket",
      wording: "scheduled OpenWiki Bitbucket pipeline refreshes",
    },
    {
      provider: "none",
      wording: "scheduled OpenWiki update job refreshes",
    },
  ])(
    "skips the GitHub workflow and uses matching wording for $provider",
    async ({ provider, wording }) => {
      const repo = await createTempRepo();

      await withCiProvider(provider, () => ensureCodeModeRepoSetup(repo));

      const workflow = await readIfPresent(
        path.join(repo, WORKFLOW_RELATIVE_PATH),
      );
      expect(
        workflow,
        `no GitHub workflow should be written for ${provider}`,
      ).toBeNull();

      for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
        const content = await readIfPresent(path.join(repo, fileName));
        expect(content).toContain(wording);
        expect(content).not.toContain("GitHub Actions workflow");
      }
    },
  );

  test("detects the provider from the git remote host", async () => {
    const repo = await createTempRepo();
    await initGitRepoWithRemote(repo, "git@bitbucket.org:acme/widgets.git");

    await ensureCodeModeRepoSetup(repo);

    const workflow = await readIfPresent(
      path.join(repo, WORKFLOW_RELATIVE_PATH),
    );
    expect(
      workflow,
      "Bitbucket repos should not get a GitHub workflow",
    ).toBeNull();

    const claude = await readIfPresent(path.join(repo, "CLAUDE.md"));
    expect(claude).toContain("scheduled OpenWiki Bitbucket pipeline refreshes");
  });

  test("env override wins over the detected git remote host", async () => {
    const repo = await createTempRepo();
    await initGitRepoWithRemote(repo, "git@github.com:acme/widgets.git");

    await withCiProvider("none", () => ensureCodeModeRepoSetup(repo));

    const workflow = await readIfPresent(
      path.join(repo, WORKFLOW_RELATIVE_PATH),
    );
    expect(workflow).toBeNull();

    const claude = await readIfPresent(path.join(repo, "CLAUDE.md"));
    expect(claude).toContain("scheduled OpenWiki update job refreshes");
  });
});
