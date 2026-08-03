import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createUserPrompt } from "../src/agent/prompt.ts";
import { createRunContext } from "../src/agent/utils.ts";

const TEMP_REPO_PREFIX = "openwiki-ci-context-";
const TEMP_SECRET_PREFIX = "openwiki-ci-secret-";
const GITHUB_WORKFLOW_DIR = ".github/workflows";
const OPENWIKI_WORKFLOW_FILE = "openwiki-update.yml";
const OPENWIKI_WORKFLOW_PATH = `${GITHUB_WORKFLOW_DIR}/${OPENWIKI_WORKFLOW_FILE}`;
const GITLAB_CI_PATH = ".gitlab-ci.yml";
const BITBUCKET_PIPELINES_PATH = "bitbucket-pipelines.yml";
const EXTERNAL_WORKFLOW_FILE = "leak.yml";
const ANTHROPIC_PROVIDER_LINE = "OPENWIKI_PROVIDER: anthropic";
const ANTHROPIC_MODEL_LINE = "OPENWIKI_MODEL_ID: claude-sonnet-5";
const OPENROUTER_PROVIDER_LINE = "OPENWIKI_PROVIDER: openrouter";
const GITLAB_JOB_NAME = "gitlab_update_docs";
const BITBUCKET_STEP_NAME = "Bitbucket OpenWiki refresh";
const NO_CI_CONFIG_MESSAGE =
  "No checked-out CI configuration files were found in this repository.";
const TRUNCATED_CONTEXT_MARKER = "[...truncated, ";
const SYMLINK_SECRET_CONTENT = "SECRET_TOKEN=do-not-leak";
const LARGE_WORKFLOW_COMMENT = "# repeated workflow context";
const LARGE_WORKFLOW_REPEAT_COUNT = 3_500;

const tempRepos: string[] = [];
const tempSecretDirs: string[] = [];

async function createTempRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), TEMP_REPO_PREFIX));
  tempRepos.push(repo);

  return repo;
}

async function createTempSecretFile(): Promise<string> {
  const secretDir = await mkdtemp(path.join(tmpdir(), TEMP_SECRET_PREFIX));
  tempSecretDirs.push(secretDir);
  const secretPath = path.join(secretDir, "secret.txt");
  await writeFile(secretPath, SYMLINK_SECRET_CONTENT, "utf8");

  return secretPath;
}

async function createTempSecretDir(): Promise<string> {
  const secretDir = await mkdtemp(path.join(tmpdir(), TEMP_SECRET_PREFIX));
  tempSecretDirs.push(secretDir);

  return secretDir;
}

afterEach(async () => {
  await Promise.all(
    [...tempRepos.splice(0), ...tempSecretDirs.splice(0)].map((repo) =>
      rm(repo, { force: true, recursive: true }),
    ),
  );
});

describe("repository CI context", () => {
  test("injects checked-out workflow configuration into repository update prompts", async () => {
    const repo = await createTempRepo();
    await mkdir(path.join(repo, GITHUB_WORKFLOW_DIR), { recursive: true });
    await writeFile(
      path.join(repo, OPENWIKI_WORKFLOW_PATH),
      `
name: OpenWiki Update

jobs:
  update:
    steps:
      - run: openwiki --update --print
        env:
          ${ANTHROPIC_PROVIDER_LINE}
          ${ANTHROPIC_MODEL_LINE}
`.trimStart(),
      "utf8",
    );

    const context = await createRunContext("update", repo, "repository");
    const prompt = createUserPrompt("update", context, null, "repository");

    expect(context.ciSummary).toBeDefined();
    expect(context.ciSummary).toContain(OPENWIKI_WORKFLOW_PATH);
    expect(context.ciSummary).toContain(ANTHROPIC_PROVIDER_LINE);
    expect(prompt).toContain(ANTHROPIC_MODEL_LINE);
    expect(prompt).not.toContain(OPENROUTER_PROVIDER_LINE);
  });

  test("includes GitLab CI and Bitbucket Pipelines files", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, GITLAB_CI_PATH),
      `${GITLAB_JOB_NAME}:\n  script: openwiki --update --print\n`,
      "utf8",
    );
    await writeFile(
      path.join(repo, BITBUCKET_PIPELINES_PATH),
      `pipelines:\n  default:\n    - step:\n        name: ${BITBUCKET_STEP_NAME}\n`,
      "utf8",
    );

    const context = await createRunContext("update", repo, "repository");

    expect(context.ciSummary).toContain(GITLAB_CI_PATH);
    expect(context.ciSummary).toContain(GITLAB_JOB_NAME);
    expect(context.ciSummary).toContain(BITBUCKET_PIPELINES_PATH);
    expect(context.ciSummary).toContain(BITBUCKET_STEP_NAME);
  });

  test("reports when no checked-out CI configuration files exist", async () => {
    const repo = await createTempRepo();

    const context = await createRunContext("update", repo, "repository");
    const prompt = createUserPrompt("update", context, null, "repository");

    expect(context.ciSummary).toBe(NO_CI_CONFIG_MESSAGE);
    expect(prompt).toContain(NO_CI_CONFIG_MESSAGE);
  });

  test("does not compute repository CI context for local wiki runs", async () => {
    const repo = await createTempRepo();
    await mkdir(path.join(repo, GITHUB_WORKFLOW_DIR), { recursive: true });
    await writeFile(
      path.join(repo, OPENWIKI_WORKFLOW_PATH),
      `${ANTHROPIC_PROVIDER_LINE}\n`,
      "utf8",
    );

    const context = await createRunContext("update", repo, "local-wiki");
    const prompt = createUserPrompt("update", context, null, "local-wiki");

    expect(context.ciSummary).toBeUndefined();
    expect(prompt).toContain(
      "Repository automation context:\n(not applicable)",
    );
    expect(prompt).not.toContain(ANTHROPIC_PROVIDER_LINE);
  });

  test("truncates oversized repository CI context with an explicit byte count", async () => {
    const repo = await createTempRepo();
    await mkdir(path.join(repo, GITHUB_WORKFLOW_DIR), { recursive: true });
    await writeFile(
      path.join(repo, OPENWIKI_WORKFLOW_PATH),
      Array.from(
        { length: LARGE_WORKFLOW_REPEAT_COUNT },
        () => LARGE_WORKFLOW_COMMENT,
      ).join("\n"),
      "utf8",
    );

    const context = await createRunContext("update", repo, "repository");

    expect(context.ciSummary).toContain(OPENWIKI_WORKFLOW_PATH);
    expect(context.ciSummary).toContain(TRUNCATED_CONTEXT_MARKER);
  });

  test("does not follow symlinks for direct CI config paths", async () => {
    const repo = await createTempRepo();
    const secretPath = await createTempSecretFile();
    await symlink(secretPath, path.join(repo, GITLAB_CI_PATH));

    const context = await createRunContext("update", repo, "repository");

    expect(context.ciSummary).not.toContain(SYMLINK_SECRET_CONTENT);
    expect(context.ciSummary).not.toContain(GITLAB_CI_PATH);
  });

  test("does not follow symlinked GitHub workflows directories", async () => {
    const repo = await createTempRepo();
    const secretDir = await createTempSecretDir();
    await writeFile(
      path.join(secretDir, EXTERNAL_WORKFLOW_FILE),
      SYMLINK_SECRET_CONTENT,
      "utf8",
    );
    await mkdir(path.join(repo, ".github"), { recursive: true });
    await symlink(secretDir, path.join(repo, GITHUB_WORKFLOW_DIR));

    const context = await createRunContext("update", repo, "repository");

    expect(context.ciSummary).not.toContain(SYMLINK_SECRET_CONTENT);
    expect(context.ciSummary).not.toContain(EXTERNAL_WORKFLOW_FILE);
  });
});
