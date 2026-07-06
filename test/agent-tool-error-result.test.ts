import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  UPDATE_METADATA_PATH,
} from "../src/constants.ts";
import type { OpenWikiRunEvent } from "../src/agent/types.ts";

const execFileAsync = promisify(execFile);
const envKeys = [
  "HOME",
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
] as const;
const originalEnv = new Map(
  envKeys.map((key) => [key, process.env[key]] as const),
);

let activeRepo: string | null = null;
let streamScenario: "success" | "tool-error" = "success";
let tempRoots: string[] = [];

beforeEach(() => {
  vi.resetModules();
  restoreEnv();
  activeRepo = null;
  streamScenario = "success";
  tempRoots = [];
});

afterEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  restoreEnv();

  await Promise.all(
    tempRoots.map((tempRoot) => rm(tempRoot, { force: true, recursive: true })),
  );
});

describe("runOpenWikiAgent tool-error result tracking", () => {
  test("records tool-error stream events and skips successful-update metadata", async () => {
    const { repo, home } = await createTestContext();
    const { runOpenWikiAgent } = await importAgentWithMockedDependencies(home);
    const events: OpenWikiRunEvent[] = [];

    activeRepo = repo;
    streamScenario = "tool-error";

    const result = await runOpenWikiAgent("init", repo, {
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({
      command: "init",
      model: "z-ai/glm-5.2",
      hadToolError: true,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "tool_start",
        id: "tool-1",
        name: "write_file",
      }),
      expect.objectContaining({
        type: "tool_end",
        id: "tool-1",
        name: "write_file",
        status: "error",
      }),
    ]);
    await expect(
      readFile(path.join(repo, UPDATE_METADATA_PATH), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("leaves clean runs unflagged and records update metadata", async () => {
    const { repo, home } = await createTestContext();
    const { runOpenWikiAgent } = await importAgentWithMockedDependencies(home);

    activeRepo = repo;
    streamScenario = "success";

    const result = await runOpenWikiAgent("init", repo);

    expect(result).toEqual({
      command: "init",
      model: "z-ai/glm-5.2",
    });

    const metadata = JSON.parse(
      await readFile(path.join(repo, UPDATE_METADATA_PATH), "utf8"),
    ) as Record<string, unknown>;
    expect(metadata.command).toBe("init");
    expect(metadata.model).toBe("z-ai/glm-5.2");
  });
});

async function importAgentWithMockedDependencies(
  home: string,
): Promise<typeof import("../src/agent/index.ts")> {
  installDependencyMocks();
  process.env.HOME = home;
  process.env[OPENROUTER_API_KEY_ENV_KEY] = "test-openrouter-key";
  process.env[OPENWIKI_MODEL_ID_ENV_KEY] = "z-ai/glm-5.2";
  process.env[OPENWIKI_PROVIDER_ENV_KEY] = "openrouter";

  return import("../src/agent/index.ts");
}

function installDependencyMocks(): void {
  vi.doMock("@langchain/anthropic", () => ({
    ChatAnthropic: class ChatAnthropic {},
  }));
  vi.doMock("@langchain/openai", () => ({
    ChatOpenAI: class ChatOpenAI {},
  }));
  vi.doMock("@langchain/openrouter", () => ({
    ChatOpenRouter: class ChatOpenRouter {},
  }));
  vi.doMock("@langchain/langgraph-checkpoint-sqlite", () => ({
    SqliteSaver: {
      fromConnString: () => ({}),
    },
  }));
  vi.doMock("deepagents", () => ({
    LocalShellBackend: class LocalShellBackend {
      readonly options: unknown;

      constructor(options: unknown) {
        this.options = options;
      }
    },
    createDeepAgent: () => ({
      stream: () => createMockStream(),
    }),
  }));
}

async function* createMockStream(): AsyncGenerator<unknown> {
  if (!activeRepo) {
    throw new Error("Test stream missing active repo.");
  }

  await writeFile(
    path.join(activeRepo, "openwiki", "quickstart.md"),
    streamScenario === "tool-error"
      ? "# Quickstart\nPartial update\n"
      : "# Quickstart\nSuccessful update\n",
    "utf8",
  );

  yield [
    "tools",
    {
      event: "on_tool_start",
      input: { file_path: "/openwiki/quickstart.md" },
      name: "write_file",
      toolCallId: "tool-1",
    },
  ];
  yield [
    "tools",
    {
      event: streamScenario === "tool-error" ? "on_tool_error" : "on_tool_end",
      input: { file_path: "/openwiki/quickstart.md" },
      name: "write_file",
      toolCallId: "tool-1",
    },
  ];
}

async function createTestContext(): Promise<{ home: string; repo: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-tool-error-"));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");

  tempRoots.push(root);
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await createRepoWithOpenWiki(repo);

  return { home, repo };
}

async function createRepoWithOpenWiki(repo: string): Promise<void> {
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenWiki Test"]);
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");
  await mkdir(path.join(repo, "openwiki"));
  await writeFile(
    path.join(repo, "openwiki", "quickstart.md"),
    "# Quickstart\n",
    "utf8",
  );
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = originalEnv.get(key);

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
