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
      // The REPL resolves its ptc list by name and SILENTLY drops a name that
      // matches no registered tool, which would turn author_pages back into
      // model-written scheduling with nothing failing. So the registration is
      // asserted here, per command, rather than trusted.
      const middlewareNames = options.middleware.map(
        (middleware: { name: string }) => middleware.name,
      );
      if (command === "init") {
        expect(middlewareNames).toContain("OpenWikiAuthoringPoolMiddleware");
        const pool = options.middleware.find(
          (middleware: { name: string }) =>
            middleware.name === "OpenWikiAuthoringPoolMiddleware",
        ) as { tools: { name: string }[] };
        expect(pool.tools.map((pooled) => pooled.name)).toEqual([
          "author_pages",
        ]);
        // DeepAgents adds general-purpose unless a harness profile disables it,
        // and profiles resolve off the model instance for only some providers.
        // Nothing fails when the guard is missing - the run simply regains a
        // subagent that authors without a brief or claims - so assert it here.
        expect(middlewareNames).toContain(
          "OpenWikiGeneralPurposeGuardMiddleware",
        );
      } else {
        expect(middlewareNames).not.toContain(
          "OpenWikiAuthoringPoolMiddleware",
        );
        // An update has no named subagents at all, so refusing general-purpose
        // would leave `task()` with no target rather than a better one.
        expect(middlewareNames).not.toContain(
          "OpenWikiGeneralPurposeGuardMiddleware",
        );
      }
      expect(
        options.middleware.map((middleware) => middleware.name),
      ).not.toContain("OpenWikiClaimsCompletionMiddleware");
      expect(options.subagents).toHaveLength(command === "init" ? 4 : 0);
      if (command === "init") {
        expect(
          options.subagents.map(
            (subagent) => (subagent as { name: string }).name,
          ),
        ).toEqual([
          "skeleton-critic",
          "wiki-question-finder",
          "wiki-answer-verifier",
          "page-author",
        ]);
        // The coordinator is the single Claims writer, and every subagent is
        // told so in its own system prompt. The init prompt used to carry this
        // as one blanket sentence; it moved here when the prompt was trimmed,
        // where it is checked per subagent instead of asserted once in prose.
        const promptFor = (name: string) =>
          (
            options.subagents.find(
              (subagent) => (subagent as { name: string }).name === name,
            ) as { systemPrompt: string }
          ).systemPrompt;
        for (const name of [
          "skeleton-critic",
          "wiki-question-finder",
          "wiki-answer-verifier",
        ]) {
          expect(promptFor(name)).toContain(
            "Never call or propose Claims mutations",
          );
        }
        // The author establishes its own page's claims now: it is the only
        // participant that can repair bad evidence, because it has the file
        // open. The read-only reviewers above still may not touch Claims.
        // The author cannot write prose without claims: there is one atomic
        // operation and no separate write on its surface.
        expect(promptFor("page-author")).toContain("establish_claims");
        expect(promptFor("page-author")).toContain("write_page");
        expect(promptFor("page-author")).toContain("OKF v0.2");
        expect(promptFor("page-author")).not.toContain("OKF v0.1");
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
