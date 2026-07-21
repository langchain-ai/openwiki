import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ensureCodeModeRepoSetup } from "../src/code-mode.ts";
import { OPENWIKI_VERSION } from "../src/constants.ts";

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
  test("does not create a CI file without an explicit choice", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo);

    expect(
      await readIfPresent(
        path.join(repo, ".github", "workflows", "openwiki-update.yml"),
      ),
    ).toBeNull();
    expect(await readIfPresent(path.join(repo, ".gitlab-ci.yml"))).toBeNull();
  });

  test("GitHub Actions includes agent files and the workflow in add-paths", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo, "github");

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
    expect(workflow).toContain("actions/checkout@11bd7190");
    expect(workflow).toContain(
      `npm install --global openwiki@${OPENWIKI_VERSION}`,
    );
  });

  test("GitLab CI uses the standard filename and GitLab-managed paths", async () => {
    const repo = await createTempRepo();

    await ensureCodeModeRepoSetup(repo, "gitlab");

    const pipeline = await readIfPresent(path.join(repo, ".gitlab-ci.yml"));
    expect(pipeline).not.toBeNull();
    expect(pipeline).toContain("openwiki_update:");
    expect(pipeline).toContain("$CI_PIPELINE_SOURCE");
    expect(pipeline).toContain(
      "git add openwiki AGENTS.md CLAUDE.md .gitlab-ci.yml",
    );
    expect(pipeline).not.toContain(".github/workflows/openwiki-update.yml");
    expect(
      await readIfPresent(
        path.join(repo, ".github", "workflows", "openwiki-update.yml"),
      ),
    ).toBeNull();
  });
});
