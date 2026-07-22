import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { createRunContext, getUpdateNoopStatus } from "../src/agent/utils.ts";

const execFileAsync = promisify(execFile);
const tempRepos: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/**
 * Builds a monorepo with two subprojects, each with its own openwiki/ sub-wiki
 * and a .last-update.json pinned to the initial commit.
 */
async function createMonorepo(): Promise<{
  repo: string;
  initialHead: string;
}> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-scope-"));
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

describe("subproject-scoped git evidence (Variant B)", () => {
  test("createGitSummary scoped to foo returns only foo-subtree paths", async () => {
    const { repo, initialHead } = await createMonorepo();
    const fooDir = path.join(repo, "packages", "foo");
    await writeLastUpdate(fooDir, initialHead);

    // Commit changes in BOTH foo and bar.
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

    const context = await createRunContext("update", fooDir, "repository", {
      mode: "subproject",
    });

    // Foo's own source is present, subproject-relative (no packages/foo prefix).
    expect(context.gitSummary).toContain("src/code.ts");
    // Bar's source must NOT leak into foo's evidence.
    expect(context.gitSummary).not.toContain("packages/bar");
    expect(context.gitSummary).not.toContain("bar/src/code.ts");
  });

  test("getUpdateNoopStatus(foo) SKIPS when only bar changed", async () => {
    const { repo, initialHead } = await createMonorepo();
    const fooDir = path.join(repo, "packages", "foo");
    await writeLastUpdate(fooDir, initialHead);

    await writeFile(
      path.join(repo, "packages", "bar", "src", "code.ts"),
      "export const bar = 2;\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "change bar only"]);

    const status = await getUpdateNoopStatus(fooDir, { mode: "subproject" });
    expect(status.shouldSkip).toBe(true);
  });

  test("getUpdateNoopStatus(foo) RUNS when foo changed", async () => {
    const { repo, initialHead } = await createMonorepo();
    const fooDir = path.join(repo, "packages", "foo");
    await writeLastUpdate(fooDir, initialHead);

    await writeFile(
      path.join(fooDir, "src", "code.ts"),
      "export const foo = 2;\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "change foo"]);

    const status = await getUpdateNoopStatus(fooDir, { mode: "subproject" });
    expect(status.shouldSkip).toBe(false);
  });

  test("getUpdateNoopStatus(foo) SKIPS when only foo's own openwiki changed", async () => {
    const { repo, initialHead } = await createMonorepo();
    const fooDir = path.join(repo, "packages", "foo");
    await writeLastUpdate(fooDir, initialHead);

    await writeFile(
      path.join(fooDir, "openwiki", "quickstart.md"),
      "# foo updated\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "update foo docs"]);

    const status = await getUpdateNoopStatus(fooDir, { mode: "subproject" });
    expect(status.shouldSkip).toBe(true);
  });
});

describe("root-excluding-nested git evidence (D1)", () => {
  test("root summary excludes nested openwiki but keeps root openwiki", async () => {
    const { repo, initialHead } = await createMonorepo();
    await writeLastUpdate(repo, initialHead);

    // Simulate subproject runs dirtying nested wikis, plus a real source change
    // and a root-wiki change.
    await writeFile(
      path.join(repo, "packages", "foo", "openwiki", "quickstart.md"),
      "# foo regenerated\n",
    );
    await writeFile(
      path.join(repo, "packages", "foo", "src", "code.ts"),
      "export const foo = 3;\n",
    );
    await writeFile(
      path.join(repo, "openwiki", "quickstart.md"),
      "# root regenerated\n",
    );

    const context = await createRunContext("update", repo, "repository", {
      mode: "root-excluding-nested",
    });

    // Nested sub-wiki churn is excluded from the root's evidence.
    expect(context.gitSummary).not.toContain("packages/foo/openwiki");
    // Real source change is still visible.
    expect(context.gitSummary).toContain("packages/foo/src/code.ts");
    // Root's own wiki is preserved (it's the doc target and legitimate context).
    expect(context.gitSummary).toContain("openwiki/quickstart.md");
  });
});

/**
 * Installs a fake `git` on PATH that appends its argv to a log file and then
 * delegates to the real git. Lets a test assert the EXACT argument vectors util
 * functions pass, proving the scope-absent contract byte-for-byte.
 */
async function withGitArgvCapture<T>(
  fn: (getArgs: () => Promise<string[][]>) => Promise<T>,
): Promise<T> {
  const shimDir = await mkdtemp(path.join(tmpdir(), "openwiki-gitshim-"));
  tempRepos.push(shimDir);
  const logFile = path.join(shimDir, "argv.log");
  const realGit = (await execFileAsync("which", ["git"])).stdout.trim();
  const shimPath = path.join(shimDir, "git");
  await writeFile(
    shimPath,
    `#!/usr/bin/env bash\nprintf '%s\\0' "$@" >> ${JSON.stringify(
      logFile,
    )}\nprintf '\\n' >> ${JSON.stringify(
      logFile,
    )}\nexec ${JSON.stringify(realGit)} "$@"\n`,
    "utf8",
  );
  await chmod(shimPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;
  try {
    return await fn(async () => {
      const raw = await readFile(logFile, "utf8").catch(() => "");
      return raw
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => line.split("\0").filter(Boolean));
    });
  } finally {
    process.env.PATH = originalPath;
  }
}

describe("scope-absent commands are byte-identical to today", () => {
  test("no scope issues no --relative and no pathspec", async () => {
    const { repo, initialHead } = await createMonorepo();
    await writeLastUpdate(repo, initialHead);
    await writeFile(path.join(repo, "README.md"), "# root changed\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "change readme"]);

    await withGitArgvCapture(async (getArgs) => {
      await createRunContext("update", repo, "repository");
      const calls = await getArgs();

      // Every captured git invocation is prefixed with --no-pager (runGit).
      const evidence = calls.filter((call) => call.includes("--no-pager"));
      expect(evidence.length).toBeGreaterThan(0);

      for (const call of evidence) {
        // The scope-absent contract: no --relative and no `--` pathspec.
        expect(call).not.toContain("--relative");
        expect(call).not.toContain("--");
      }

      // status --short is exactly ["--no-pager","status","--short"].
      const statusCall = evidence.find(
        (call) => call[1] === "status" && call[2] === "--short",
      );
      expect(statusCall).toEqual(["--no-pager", "status", "--short"]);
    });
  });

  test("subproject scope adds --relative and `-- .` on diff", async () => {
    const { repo, initialHead } = await createMonorepo();
    const fooDir = path.join(repo, "packages", "foo");
    await writeLastUpdate(fooDir, initialHead);

    await withGitArgvCapture(async (getArgs) => {
      await createRunContext("update", fooDir, "repository", {
        mode: "subproject",
      });
      const calls = await getArgs();
      const diffCall = calls.find(
        (call) => call.includes("diff") && call.includes("--name-status"),
      );
      expect(diffCall).toContain("--relative");
      expect(diffCall).toContain("--");
      expect(diffCall).toContain(".");

      // status is scoped with `-- .` but NOT --relative.
      const statusCall = calls.find(
        (call) => call[1] === "status" && call.includes("--short"),
      );
      expect(statusCall).toContain("--");
      expect(statusCall).toContain(".");
      expect(statusCall).not.toContain("--relative");
    });
  });
});
