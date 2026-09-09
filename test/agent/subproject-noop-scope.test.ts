import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  getRepositoryChangedPaths,
  getUpdateNoopStatus,
} from "../../src/agent/utils.ts";
import { OpenWikiIgnore } from "../../src/agent/openwiki-ignore.ts";

/**
 * Recursive monorepo runs scope each subproject's git evidence to its own
 * subtree with a pathspec, because `git status`/`git diff` are repo-wide
 * regardless of cwd. Without the scope, any sibling commit advances the shared
 * HEAD and every subproject would regenerate on the next `--update` — inverting
 * the feature's "no dependency cascade" / cheap incremental-skip contract. These
 * tests pin that scoping behavior (the guarantee lives in the git layer, below
 * the model, so it can be tested directly and deterministically).
 */
const execFileAsync = promisify(execFile);
const tempRepos: string[] = [];
const noIgnore = new OpenWikiIgnore([]);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createMonorepo(): Promise<{ repo: string; initialHead: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-noop-scope-"));
  tempRepos.push(repo);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenWiki Test"]);

  for (const pkg of ["foo", "bar"]) {
    await mkdir(path.join(repo, "packages", pkg, "src"), { recursive: true });
    await mkdir(path.join(repo, "packages", pkg, "openwiki"), {
      recursive: true,
    });
    await writeFile(
      path.join(repo, "packages", pkg, "src", "code.ts"),
      `export const ${pkg} = 1;\n`,
      "utf8",
    );
    await writeFile(
      path.join(repo, "packages", pkg, "openwiki", "quickstart.md"),
      `# ${pkg}\n`,
      "utf8",
    );
  }
  await mkdir(path.join(repo, "openwiki"), { recursive: true });
  await writeFile(path.join(repo, "openwiki", "quickstart.md"), "# root\n");
  await writeFile(path.join(repo, "README.md"), "# root\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  const initialHead = await git(repo, ["rev-parse", "HEAD"]);

  return { repo, initialHead };
}

async function writeLastUpdate(dir: string, gitHead: string): Promise<void> {
  await mkdir(path.join(dir, "openwiki"), { recursive: true });
  await writeFile(
    path.join(dir, "openwiki", ".last-update.json"),
    `${JSON.stringify({
      updatedAt: new Date().toISOString(),
      command: "update",
      gitHead,
      model: "test-model",
      status: "complete",
      language: "en",
    })}\n`,
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(
    tempRepos
      .splice(0)
      .map((repo) => rm(repo, { force: true, recursive: true })),
  );
});

describe("subproject-scoped update no-op", () => {
  test("SKIPS when only a sibling subproject changed (committed)", async () => {
    const { repo, initialHead } = await createMonorepo();
    const fooDir = path.join(repo, "packages", "foo");
    await writeLastUpdate(fooDir, initialHead);

    // A commit that touches only bar advances the shared HEAD.
    await writeFile(
      path.join(repo, "packages", "bar", "src", "code.ts"),
      "export const bar = 2;\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "change bar only"]);

    const status = await getUpdateNoopStatus(fooDir, noIgnore, undefined, {
      mode: "subproject",
    });
    expect(status.shouldSkip).toBe(true);
  });

  test("without a scope, a sibling commit forces regeneration (why the scope exists)", async () => {
    const { repo, initialHead } = await createMonorepo();
    const fooDir = path.join(repo, "packages", "foo");
    await writeLastUpdate(fooDir, initialHead);

    await writeFile(
      path.join(repo, "packages", "bar", "src", "code.ts"),
      "export const bar = 2;\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "change bar only"]);

    // Repo-wide (no scope) sees bar's change and does NOT skip — this is the
    // regression the subproject scope prevents.
    const status = await getUpdateNoopStatus(fooDir, noIgnore);
    expect(status.shouldSkip).toBe(false);
  });

  test("RUNS when the subproject's own source changed (committed)", async () => {
    const { repo, initialHead } = await createMonorepo();
    const fooDir = path.join(repo, "packages", "foo");
    await writeLastUpdate(fooDir, initialHead);

    await writeFile(
      path.join(fooDir, "src", "code.ts"),
      "export const foo = 2;\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "change foo"]);

    const status = await getUpdateNoopStatus(fooDir, noIgnore, undefined, {
      mode: "subproject",
    });
    expect(status.shouldSkip).toBe(false);
  });

  test("SKIPS when only the subproject's own openwiki changed (committed)", async () => {
    const { repo, initialHead } = await createMonorepo();
    const fooDir = path.join(repo, "packages", "foo");
    await writeLastUpdate(fooDir, initialHead);

    await writeFile(
      path.join(fooDir, "openwiki", "quickstart.md"),
      "# foo updated\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "update foo docs"]);

    const status = await getUpdateNoopStatus(fooDir, noIgnore, undefined, {
      mode: "subproject",
    });
    expect(status.shouldSkip).toBe(true);
  });

  test("SKIPS when only a sibling changed in the worktree (uncommitted)", async () => {
    const { repo, initialHead } = await createMonorepo();
    const fooDir = path.join(repo, "packages", "foo");
    await writeLastUpdate(fooDir, initialHead);

    // Uncommitted sibling change: repo-wide `git status` would report it, but the
    // subproject-scoped status must not.
    await writeFile(
      path.join(repo, "packages", "bar", "src", "code.ts"),
      "export const bar = 3;\n",
    );

    const status = await getUpdateNoopStatus(fooDir, noIgnore, undefined, {
      mode: "subproject",
    });
    expect(status.shouldSkip).toBe(true);
  });
});

describe("subproject-scoped planner evidence", () => {
  test("returns only the subproject's own changed paths, subproject-relative", async () => {
    const { repo, initialHead } = await createMonorepo();
    const fooDir = path.join(repo, "packages", "foo");

    await writeFile(
      path.join(fooDir, "src", "code.ts"),
      "export const foo = 2;\n",
    );
    await writeFile(
      path.join(repo, "packages", "bar", "src", "code.ts"),
      "export const bar = 2;\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "change foo and bar"]);

    const changed = await getRepositoryChangedPaths(fooDir, noIgnore, initialHead, {
      mode: "subproject",
    });
    expect(changed).toContain("src/code.ts");
    expect(changed.some((p) => p.includes("bar"))).toBe(false);
    expect(changed.some((p) => p.startsWith("packages/"))).toBe(false);
  });
});

describe("root-excluding-nested planner evidence", () => {
  test("drops nested sub-wiki churn while keeping root source", async () => {
    const { repo, initialHead } = await createMonorepo();

    await writeFile(path.join(repo, "README.md"), "# root v2\n");
    await writeFile(
      path.join(repo, "packages", "foo", "openwiki", "quickstart.md"),
      "# foo regenerated\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "root + nested churn"]);

    // Contrast: repo-wide evidence leaks the nested sub-wiki path (isOpenWikiPath
    // only filters the ROOT openwiki/, not nested packages/*/openwiki/).
    const unscoped = await getRepositoryChangedPaths(repo, noIgnore, initialHead);
    expect(unscoped).toContain("packages/foo/openwiki/quickstart.md");

    const scoped = await getRepositoryChangedPaths(repo, noIgnore, initialHead, {
      mode: "root-excluding-nested",
    });
    // Root non-nested source is still present; freshly generated nested sub-wikis
    // are excluded so the root planner is not fed sub-wiki churn as source.
    expect(scoped).toContain("README.md");
    expect(scoped).not.toContain("packages/foo/openwiki/quickstart.md");
  });
});
