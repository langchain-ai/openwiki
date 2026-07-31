import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  CODE_MODE_CONFIG_FILENAME,
  resolveCodeModeAgentFilesPolicy,
} from "../src/code-mode-config.ts";
import { ensureCodeModeRepoSetup } from "../src/code-mode.ts";

const tempRepos: string[] = [];

async function createTempRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-code-config-"));
  tempRepos.push(repo);
  return repo;
}

async function writeConfig(repo: string, contents: string): Promise<void> {
  await writeFile(path.join(repo, CODE_MODE_CONFIG_FILENAME), contents, "utf8");
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

describe("resolveCodeModeAgentFilesPolicy", () => {
  test("defaults to manage when no config or CLI override exists", async () => {
    const repo = await createTempRepo();

    await expect(resolveCodeModeAgentFilesPolicy(repo)).resolves.toEqual({
      configuredPolicy: null,
      policy: "manage",
      source: "default",
    });
  });

  for (const policy of ["manage", "preserve"] as const) {
    test(`reads ${policy} from committed config`, async () => {
      const repo = await createTempRepo();
      await writeConfig(
        repo,
        `codeMode:\n  agentFiles:\n    policy: ${policy}\n`,
      );

      await expect(resolveCodeModeAgentFilesPolicy(repo)).resolves.toEqual({
        configuredPolicy: policy,
        policy,
        source: "config",
      });
    });
  }

  for (const [configuredPolicy, cliPolicy] of [
    ["manage", "preserve"],
    ["preserve", "manage"],
  ] as const) {
    test(`CLI ${cliPolicy} overrides config ${configuredPolicy}`, async () => {
      const repo = await createTempRepo();
      await writeConfig(
        repo,
        `codeMode:\n  agentFiles:\n    policy: ${configuredPolicy}\n`,
      );

      await expect(
        resolveCodeModeAgentFilesPolicy(repo, cliPolicy),
      ).resolves.toEqual({
        configuredPolicy,
        policy: cliPolicy,
        source: "cli",
      });
    });
  }

  test("a CLI override neither rewrites nor creates config", async () => {
    const configuredRepo = await createTempRepo();
    const original =
      "# Repository policy\ncodeMode:\n  agentFiles:\n    policy: manage\n";
    await writeConfig(configuredRepo, original);

    await ensureCodeModeRepoSetup(configuredRepo, {
      agentFilesPolicy: "preserve",
    });

    expect(
      await readFile(
        path.join(configuredRepo, CODE_MODE_CONFIG_FILENAME),
        "utf8",
      ),
    ).toBe(original);

    const unconfiguredRepo = await createTempRepo();
    await ensureCodeModeRepoSetup(unconfiguredRepo, {
      agentFilesPolicy: "preserve",
    });
    expect(
      await readIfPresent(
        path.join(unconfiguredRepo, CODE_MODE_CONFIG_FILENAME),
      ),
    ).toBeNull();
  });

  test("rejects an unknown configured policy", async () => {
    const repo = await createTempRepo();
    await writeConfig(repo, "codeMode:\n  agentFiles:\n    policy: ignore\n");

    await expect(resolveCodeModeAgentFilesPolicy(repo)).rejects.toThrow(
      "Invalid openwiki.config.yaml: codeMode.agentFiles.policy must be manage or preserve.",
    );
  });

  test("rejects a scalar agentFiles value", async () => {
    const repo = await createTempRepo();
    await writeConfig(repo, "codeMode:\n  agentFiles: preserve\n");

    await expect(resolveCodeModeAgentFilesPolicy(repo)).rejects.toThrow(
      "Invalid openwiki.config.yaml: codeMode.agentFiles must be a mapping.",
    );
  });

  test("rejects malformed YAML before applying a CLI override", async () => {
    const repo = await createTempRepo();
    await writeConfig(repo, "codeMode: [\n");

    await expect(
      resolveCodeModeAgentFilesPolicy(repo, "preserve"),
    ).rejects.toThrow("Invalid openwiki.config.yaml:");
  });
});
