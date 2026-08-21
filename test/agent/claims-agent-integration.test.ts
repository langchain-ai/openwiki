import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Hoisted DeepAgents graph factory spy.
 */
const createDeepAgent = vi.hoisted(() => vi.fn());

/**
 * Isolated persistent checkpoint root used by chat graph tests.
 */
const checkpointRoot = vi.hoisted(
  () =>
    `${process.env.TMPDIR ?? "/tmp"}/openwiki-claims-agent-checkpoint-${process.pid}`,
);

vi.mock("deepagents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("deepagents")>()),
  createDeepAgent,
}));

vi.mock("../../src/agent/skills.js", () => ({
  syncBundledSkills: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/config/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/env.js")>()),
  openWikiEnvDir: checkpointRoot,
}));

vi.mock("../../src/setup/onboarding.js", () => ({
  readOpenWikiOnboardingConfig: vi.fn(() => Promise.resolve({})),
  readRepositoryWikiInstructions: vi.fn(() => Promise.resolve(undefined)),
}));

import { createOpenWikiAgent } from "../../src/agent/index.ts";

/**
 * Captured subset of the DeepAgents graph configuration.
 */
interface CapturedGraphOptions {
  /**
   * Middleware registered on the graph.
   */
  middleware: Array<{ name?: string }>;

  /**
   * Configured subagent definitions.
   */
  subagents: unknown[];

  /**
   * Explicit tools registered alongside filesystem tools.
   */
  tools: Array<{
    name: string;
    invoke(input: unknown): Promise<unknown>;
  }>;
}

/**
 * Returns the latest graph configuration captured by the factory spy.
 *
 * @returns Captured graph options.
 */
function latestGraphOptions(): CapturedGraphOptions {
  const options: unknown = (createDeepAgent.mock.calls as unknown[][]).at(
    -1,
  )?.[0];
  if (!options) {
    throw new Error("Expected createDeepAgent to be called.");
  }
  return options as CapturedGraphOptions;
}

describe("Claims agent graph integration", () => {
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    createDeepAgent.mockReset();
    createDeepAgent.mockReturnValue({
      invoke: vi.fn(),
      streamEvents: vi.fn(),
    });
  });

  afterEach(async () => {
    await Promise.all(
      [checkpointRoot, ...temporaryDirectories.splice(0)].map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  test.each(["init", "update"] as const)(
    "registers Claims tools and middleware for repository %s",
    async (command) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-claims-agent-"));
      temporaryDirectories.push(cwd);

      await createOpenWikiAgent({
        command,
        cwd,
        model: new FakeListChatModel({ responses: ["done"] }),
        outputMode: "repository",
      });

      const options = latestGraphOptions();
      expect(options.tools.map((tool) => tool.name)).toEqual([
        "delete_file",
        "resolve_claims",
        "inspect_claims",
      ]);
      expect(options.middleware.map((middleware) => middleware.name)).toContain(
        "OpenWikiClaimsReadNoteMiddleware",
      );
      expect(
        options.middleware.map((middleware) => middleware.name),
      ).not.toContain("OpenWikiClaimsCompletionMiddleware");
      expect(options.subagents).toHaveLength(command === "init" ? 3 : 0);
      if (command === "init") {
        expect(
          options.subagents.map(
            (subagent) => (subagent as { name: string }).name,
          ),
        ).toEqual([
          "skeleton-critic",
          "wiki-question-finder",
          "wiki-answer-verifier",
        ]);
      }
    },
  );

  test.each([
    ["chat", "repository"],
    ["init", "local-wiki"],
    ["update", "local-wiki"],
  ] as const)(
    "does not expose Claims for %s in %s mode",
    async (command, outputMode) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-claims-agent-"));
      temporaryDirectories.push(cwd);

      await createOpenWikiAgent({
        command,
        cwd,
        model: new FakeListChatModel({ responses: ["done"] }),
        outputMode,
      });

      const options = latestGraphOptions();
      expect(options.tools.map((tool) => tool.name)).not.toContain(
        "resolve_claims",
      );
      expect(options.tools.map((tool) => tool.name)).not.toContain(
        "inspect_claims",
      );
      expect(options.tools.map((tool) => tool.name)).not.toContain(
        "delete_file",
      );
      expect(
        options.middleware.map((middleware) => middleware.name),
      ).not.toContain("OpenWikiClaimsAuthoringMiddleware");
      expect(
        options.middleware.map((middleware) => middleware.name),
      ).not.toContain("OpenWikiClaimsCompletionMiddleware");
      expect(options.subagents).toEqual([]);
    },
  );
});
