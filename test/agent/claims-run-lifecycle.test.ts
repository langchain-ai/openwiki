import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Mutable graph harness shared with the hoisted DeepAgents mock.
 */
const graphHarness = vi.hoisted(() => ({
  /**
   * Captured graph factory calls.
   */
  createDeepAgent: vi.fn(),

  /**
   * Test-selected stream behavior.
   */
  streamBehavior: vi.fn(),
}));

vi.mock("deepagents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("deepagents")>()),
  createDeepAgent: graphHarness.createDeepAgent,
}));

vi.mock("../../src/agent/skills.js", () => ({
  syncBundledSkills: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/config/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/env.js")>()),
  loadOpenWikiEnv: vi.fn(() => Promise.resolve()),
}));

import { runOpenWikiAgent } from "../../src/agent/index.ts";
import type { OpenWikiRunEvent } from "../../src/agent/types.ts";
import { ClaimSession } from "../../src/claims/brains/code/session.ts";
import { ClaimsStore } from "../../src/claims/brains/code/store.ts";
import {
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
} from "../../src/config/constants.ts";

/**
 * Minimal tool shape exercised by the lifecycle harness.
 */
interface CapturedTool {
  /**
   * Invokes the structured tool.
   */
  invoke(input: unknown): Promise<unknown>;

  /**
   * Registered tool name.
   */
  name: string;
}

/**
 * Minimal middleware shape exercised by the lifecycle harness.
 */
interface CapturedMiddleware {
  /**
   * Registered middleware name.
   */
  name?: string;

  /**
   * Optional tool-call wrapper.
   *
   * @default undefined for middleware that does not wrap tools.
   */
  wrapToolCall?: (
    request: unknown,
    handler: (request: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
}

/**
 * Minimal backend surface used to simulate a filesystem tool write.
 */
interface CapturedBackend {
  /**
   * Writes one virtual file through the configured graph backend.
   */
  write(
    filePath: string,
    content: string,
  ): Promise<{
    /**
     * Optional backend error.
     *
     * @default undefined on success.
     */
    error?: string;

    /**
     * Optional backend result metadata.
     *
     * @default undefined when the backend did not confirm a mutation.
     */
    metadata?: Record<string, unknown>;
  }>;
}

/**
 * Captured subset of one DeepAgents graph configuration.
 */
interface CapturedGraphOptions {
  /**
   * Agent-facing filesystem backend.
   */
  backend: CapturedBackend;

  /**
   * Registered middleware.
   */
  middleware: CapturedMiddleware[];

  /**
   * Explicit Claims and connector tools.
   */
  tools: CapturedTool[];
}

/**
 * Captured stream input.
 */
interface CapturedStreamInput {
  /**
   * Initial conversation messages.
   */
  messages: Array<{
    /**
     * Message content.
     */
    content: string;
  }>;
}

/**
 * Captured stream configuration.
 */
interface CapturedStreamConfig {
  /**
   * Whether nested subgraph events are streamed.
   */
  subgraphs: boolean;
}

/**
 * Grounds and writes one factual page through the registered surfaces.
 *
 * @param options - Captured graph configuration.
 * @param page - Generated page to write.
 */
async function groundAndWritePage(
  options: CapturedGraphOptions,
  page: string,
): Promise<void> {
  const resolveClaims = options.tools.find(
    (tool) => tool.name === "resolve_claims",
  );
  if (!resolveClaims) {
    throw new Error("Claims authoring surfaces were not registered.");
  }

  await resolveClaims.invoke({
    pages: [
      {
        page,
        operations: [
          {
            op: "add",
            statement: "The repository has a README.",
            evidence: [{ resource: "repo://README.md" }],
          },
        ],
      },
    ],
  });
  const result = await options.backend.write(page, "# Page\n");
  if (result.error) throw new Error(result.error);
}

describe("Claims production run lifecycle", () => {
  const temporaryDirectories: string[] = [];
  const originalProvider = process.env[OPENWIKI_PROVIDER_ENV_KEY];
  const originalApiKey = process.env[OPENROUTER_API_KEY_ENV_KEY];

  beforeEach(() => {
    process.env[OPENWIKI_PROVIDER_ENV_KEY] = "openrouter";
    process.env[OPENROUTER_API_KEY_ENV_KEY] = "test-key";
    graphHarness.createDeepAgent.mockReset();
    graphHarness.streamBehavior.mockReset();
    graphHarness.streamBehavior.mockResolvedValue(undefined);
    graphHarness.createDeepAgent.mockImplementation(
      (options: CapturedGraphOptions) => ({
        stream: vi.fn(
          (input: CapturedStreamInput, config: CapturedStreamConfig) => ({
            /**
             * Runs the selected behavior and emits no model chunks.
             */
            async *[Symbol.asyncIterator]() {
              await graphHarness.streamBehavior(options, input, config);
              yield null;
            },
          }),
        ),
      }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalProvider === undefined) {
      delete process.env[OPENWIKI_PROVIDER_ENV_KEY];
    } else {
      process.env[OPENWIKI_PROVIDER_ENV_KEY] = originalProvider;
    }
    if (originalApiKey === undefined) {
      delete process.env[OPENROUTER_API_KEY_ENV_KEY];
    } else {
      process.env[OPENROUTER_API_KEY_ENV_KEY] = originalApiKey;
    }
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  /**
   * Creates a repository root with resolvable evidence.
   *
   * @returns Temporary repository root.
   */
  async function createRepository(): Promise<string> {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-claims-run-"));
    temporaryDirectories.push(cwd);
    await writeFile(path.join(cwd, "README.md"), "# Repository\n", "utf8");
    return cwd;
  }

  test("finalizes synchronized sidecars before complete metadata", async () => {
    const cwd = await createRepository();
    graphHarness.streamBehavior.mockImplementation(
      (options: CapturedGraphOptions) =>
        groundAndWritePage(options, "/openwiki/page.md"),
    );

    await runOpenWikiAgent("init", cwd, {
      outputMode: "repository",
    });

    const store = new ClaimsStore(cwd);
    await expect(store.loadPage("/openwiki/page.md")).resolves.toEqual(
      expect.objectContaining({
        claims: [
          expect.objectContaining({
            statement: "The repository has a README.",
          }),
        ],
      }),
    );
    await expect(
      readFile(path.join(cwd, "openwiki/.last-update.json"), "utf8").then(
        JSON.parse,
      ),
    ).resolves.toEqual(expect.objectContaining({ status: "complete" }));
    expect(graphHarness.streamBehavior).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ subgraphs: true }),
    );
  });

  test("does not turn unrelated ungrounded pages into unfinished work", async () => {
    const cwd = await createRepository();
    const completedPage = "/openwiki/completed.md";
    const unfinishedPage = "/openwiki/unfinished.md";
    await mkdir(path.join(cwd, "openwiki"));
    await writeFile(path.join(cwd, "openwiki/completed.md"), "# Ungrounded\n");
    await writeFile(path.join(cwd, "openwiki/unfinished.md"), "# Ungrounded\n");
    graphHarness.streamBehavior.mockImplementation(
      (options: CapturedGraphOptions) =>
        groundAndWritePage(options, completedPage),
    );
    const events: unknown[] = [];

    await expect(
      runOpenWikiAgent("update", cwd, {
        onEvent: (event) => events.push(event),
        outputMode: "repository",
        userMessage: "Update the wiki.",
      }),
    ).resolves.toEqual(expect.objectContaining({ command: "update" }));

    expect(
      events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "text" in event &&
          typeof event.text === "string" &&
          event.text.includes("Claims reconciliation remains"),
      ),
    ).toBe(false);
    const store = new ClaimsStore(cwd);
    await expect(store.loadPage(completedPage)).resolves.toEqual(
      expect.objectContaining({
        claims: [
          expect.objectContaining({
            statement: "The repository has a README.",
          }),
        ],
      }),
    );
    await expect(store.loadPage(unfinishedPage)).resolves.toBeNull();
    await expect(
      readFile(path.join(cwd, "openwiki/.last-update.json"), "utf8").then(
        JSON.parse,
      ),
    ).resolves.toEqual(expect.objectContaining({ status: "complete" }));
  });

  test("stamps interrupted and preserves a Claims finalization error", async () => {
    const cwd = await createRepository();
    graphHarness.streamBehavior.mockImplementation(
      async (options: CapturedGraphOptions) => {
        await options.backend.write("/openwiki/page.md", "# Partial\n");
      },
    );
    vi.spyOn(ClaimSession.prototype, "finalize").mockRejectedValueOnce(
      new Error("claims finalize failed"),
    );

    await expect(
      runOpenWikiAgent("init", cwd, { outputMode: "repository" }),
    ).rejects.toThrow("claims finalize failed");
    await expect(
      readFile(path.join(cwd, "openwiki/.last-update.json"), "utf8").then(
        JSON.parse,
      ),
    ).resolves.toEqual(expect.objectContaining({ status: "interrupted" }));
  });

  test("warns without advancing a sidecar when evidence changes during the run", async () => {
    const cwd = await createRepository();
    const events: OpenWikiRunEvent[] = [];
    graphHarness.streamBehavior.mockImplementation(
      async (options: CapturedGraphOptions) => {
        await groundAndWritePage(options, "/openwiki/page.md");
        await writeFile(path.join(cwd, "README.md"), "# Changed repository\n");
      },
    );

    await expect(
      runOpenWikiAgent("init", cwd, {
        onEvent: (event) => events.push(event),
        outputMode: "repository",
      }),
    ).resolves.toEqual(expect.objectContaining({ command: "init" }));

    const store = new ClaimsStore(cwd);
    await expect(store.loadPage("/openwiki/page.md")).resolves.toBeNull();
    expect(
      events.some(
        (event) =>
          event.type === "text" &&
          event.text.includes("Evidence changed before finalizing"),
      ),
    ).toBe(true);
    await expect(
      readFile(path.join(cwd, "openwiki/.last-update.json"), "utf8").then(
        JSON.parse,
      ),
    ).resolves.toEqual(expect.objectContaining({ status: "complete" }));
  });

  test("never advances sidecars when the agent stream fails", async () => {
    const cwd = await createRepository();
    graphHarness.streamBehavior.mockImplementation(
      async (options: CapturedGraphOptions) => {
        await groundAndWritePage(options, "/openwiki/page.md");
        throw new Error("stream failed");
      },
    );

    await expect(
      runOpenWikiAgent("init", cwd, { outputMode: "repository" }),
    ).rejects.toThrow("stream failed");

    const store = new ClaimsStore(cwd);
    await expect(store.loadPage("/openwiki/page.md")).resolves.toBeNull();
    await expect(
      readFile(path.join(cwd, "openwiki/.last-update.json"), "utf8").then(
        JSON.parse,
      ),
    ).resolves.toEqual(expect.objectContaining({ status: "interrupted" }));
  });

  test("does not inject global grounding debt when a user message bypasses no-op", async () => {
    const cwd = await createRepository();
    await mkdir(path.join(cwd, "openwiki"));
    await writeFile(path.join(cwd, "openwiki/page.md"), "# Ungrounded\n");
    graphHarness.streamBehavior.mockImplementation(
      async (options: CapturedGraphOptions, input: CapturedStreamInput) => {
        expect(input.messages[0]?.content).not.toContain("ungrounded-page");
        expect(input.messages[0]?.content).toContain(
          "If a page you read includes an OpenWiki Claims note",
        );
        await groundAndWritePage(options, "/openwiki/page.md");
      },
    );

    await runOpenWikiAgent("update", cwd, {
      outputMode: "repository",
      userMessage: "Reconcile the wiki.",
    });
  });

  test("runs Claims preflight before provider credential resolution", async () => {
    const cwd = await createRepository();
    await mkdir(path.join(cwd, "openwiki/.claims"), { recursive: true });
    await writeFile(path.join(cwd, "openwiki/page.md"), "# Page\n");
    await writeFile(path.join(cwd, "openwiki/.claims/page.json"), "not-json\n");
    delete process.env[OPENROUTER_API_KEY_ENV_KEY];

    await expect(
      runOpenWikiAgent("update", cwd, { outputMode: "repository" }),
    ).rejects.toThrow("Invalid JSON in");
    expect(graphHarness.createDeepAgent).not.toHaveBeenCalled();
  });
});
