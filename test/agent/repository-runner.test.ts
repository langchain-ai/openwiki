import { ToolMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, test, vi } from "vitest";

type HarnessPage = {
  id: string;
  path: string;
  title: string;
  purpose: string;
  seedPaths: string[];
  relatedPages: string[];
  instructions: string[];
  status: "pending" | "complete";
};

type HarnessPlan = {
  pages: HarnessPage[];
  deletePages: string[];
};

type HarnessRun = {
  root: string;
  state: {
    phase: "planning" | "generating";
    mode: "update";
    language: string;
    planningContext?: string;
    plan?: HarnessPlan;
  };
};

type CompletionTool = {
  name: string;
  invoke(input: unknown): Promise<unknown>;
};

type ModelToolRequest = {
  tools: Array<{ name: string }>;
};

type CapturedMiddleware = {
  wrapModelCall?: (
    request: ModelToolRequest,
    handler: (request: ModelToolRequest) => Promise<ModelToolRequest>,
  ) => Promise<ModelToolRequest>;
};

type CapturedAgentOptions = {
  tools: CompletionTool[];
  systemPrompt: unknown;
  subagents: unknown[];
  middleware: CapturedMiddleware[];
};

type HarnessPlanInput = {
  pages: Array<{
    path: string;
    title: string;
    purpose: string;
    instructions?: string[];
  }>;
  deletePages?: string[];
};

const harness = vi.hoisted(() => ({
  agentOptions: [] as CapturedAgentOptions[],
  beginCalls: 0,
  changedPaths: ["README.md"],
  currentRun: undefined as HarnessRun | undefined,
  driftOnce: false,
  filesystemTools: [] as string[][],
  finishCalls: 0,
  invalidPageSubmissions: 0,
  invalidPlanSubmissions: 0,
  noop: false,
  pageSubmissionCalls: 0,
  pageToolResults: [] as unknown[],
  planSubmissionCalls: 0,
  planToolResults: [] as unknown[],
  planPaths: ["/openwiki/quickstart.md", "/openwiki/architecture.md"],
  resumed: false,
}));

vi.mock("deepagents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("deepagents")>();
  return {
    ...actual,
    createFilesystemMiddleware(
      options: NonNullable<
        Parameters<typeof actual.createFilesystemMiddleware>[0]
      >,
    ) {
      harness.filesystemTools.push([...(options.tools ?? [])]);
      return actual.createFilesystemMiddleware(options);
    },
    createDeepAgent(options: CapturedAgentOptions) {
      harness.agentOptions.push(options);
      const completionTool = options.tools[0];
      const toolName = completionTool.name;
      if (toolName !== "submit_plan" && toolName !== "submit_page") {
        throw new Error(`Unexpected completion tool: ${toolName}`);
      }
      const stream = vi.fn(() =>
        Promise.resolve({
          async *[Symbol.asyncIterator]() {
            yield [
              [],
              "tools",
              {
                event: "on_tool_start",
                input: { path: "/README.md" },
                name: "read_file",
                toolCallId: `${toolName}-read`,
              },
            ];
            yield [
              [],
              "messages",
              { text: "worker narration must stay hidden" },
            ];
            yield [
              [],
              "tools",
              {
                event: "on_tool_end",
                name: "read_file",
                toolCallId: `${toolName}-read`,
              },
            ];

            if (toolName === "submit_page") {
              const page = String(options.systemPrompt).match(
                /You own exactly ([^\n]+)\./u,
              )?.[1];
              yield [
                [],
                "tools",
                {
                  event: "on_tool_start",
                  input: { path: page, content: "private worker content" },
                  name: "write_file",
                  toolCallId: `${toolName}-write-${page}`,
                },
              ];
              yield [
                [],
                "tools",
                {
                  event: "on_tool_end",
                  name: "write_file",
                  toolCallId: `${toolName}-write-${page}`,
                },
              ];
            }

            if (
              toolName === "submit_page" &&
              harness.invalidPageSubmissions > 0
            ) {
              const rejection = await completionTool.invoke({
                name: toolName,
                id: `${toolName}-invalid`,
                type: "tool_call",
                args: {
                  claims: [
                    {
                      statement: "The repository has an agent runtime.",
                      evidence: [{ resource: "src/agent/index.ts" }],
                    },
                  ],
                },
              });
              harness.pageToolResults.push(rejection);
            }
            if (
              toolName === "submit_plan" &&
              harness.invalidPlanSubmissions > 0
            ) {
              const rejection = await completionTool.invoke({
                name: toolName,
                id: `${toolName}-invalid`,
                type: "tool_call",
                args: {
                  pages: [
                    {
                      path: "/openwiki/_plan.md",
                      title: "Invalid",
                      purpose: "Exercise plan correction.",
                    },
                  ],
                },
              });
              harness.planToolResults.push(rejection);
            }

            const input =
              toolName === "submit_plan"
                ? {
                    pages: harness.planPaths.map((path) => ({
                      path,
                      title: path.split("/").at(-1)?.replace(".md", "") ?? path,
                      purpose: `Document ${path}`,
                      instructions: ["Keep the page focused."],
                    })),
                  }
                : {
                    claims: [
                      {
                        statement: "The repository has a README.",
                        evidence: [{ resource: "repo://README.md" }],
                      },
                    ],
                  };
            await completionTool.invoke(input);
          },
        }),
      );
      return { stream };
    },
  };
});

vi.mock("../../src/generation/repository-run.js", () => ({
  beginRepositoryRun() {
    harness.beginCalls += 1;
    if (harness.noop) {
      return Promise.resolve({
        view: {
          status: "noop",
          root: "/repo",
          mode: "update",
          language: "en",
          updatePreflight: { shouldSkip: true },
        },
      });
    }

    if (!harness.currentRun) {
      harness.currentRun = {
        root: "/repo",
        state: {
          phase: "planning",
          mode: "update",
          language: "en",
          planningContext: "User and connector context",
        },
      };
    }
    const run = harness.currentRun;
    return Promise.resolve({
      run,
      view: {
        status: "active",
        runId: "00000000-0000-4000-8000-000000000001",
        root: "/repo",
        mode: "update",
        language: "en",
        languageChanged: false,
        phase: run.state.phase,
        resumed: harness.resumed || harness.beginCalls > 1,
        lastUpdate: null,
        changedPaths: [...harness.changedPaths],
        claimIssues: [],
        completedPages:
          run.state.plan?.pages.filter(({ status }) => status === "complete")
            .length ?? 0,
        ...(run.state.plan ? { totalPages: run.state.plan.pages.length } : {}),
      },
    });
  },
  async submitRepositoryPlan(run: HarnessRun, input: HarnessPlanInput) {
    harness.planSubmissionCalls += 1;
    if (harness.invalidPlanSubmissions > 0) {
      harness.invalidPlanSubmissions -= 1;
      const { RepositoryRunError } =
        await import("../../src/generation/errors.js");
      throw new RepositoryRunError(
        "invalid_input",
        "Invalid or reserved OpenWiki page path: /openwiki/_plan.md",
      );
    }
    run.state.phase = "generating";
    run.state.plan = {
      pages: input.pages.map((page, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        seedPaths: [],
        relatedPages: [],
        instructions: [],
        status: "pending",
        ...page,
      })),
      deletePages: input.deletePages ?? [],
    };
    return Promise.resolve({
      status: "accepted",
      totalPages: run.state.plan.pages.length,
    });
  },
  nextRepositoryPage(run: HarnessRun) {
    const job = run.state.plan?.pages.find(
      ({ status }) => status === "pending",
    );
    return Promise.resolve(
      job
        ? {
            status: "pending",
            job: {
              ...job,
              mode: run.state.mode,
              existing: false,
              existingClaims: [],
            },
          }
        : { status: "complete" },
    );
  },
  async submitRepositoryPage(run: HarnessRun, input: { jobId: string }) {
    harness.pageSubmissionCalls += 1;
    if (harness.invalidPageSubmissions > 0) {
      harness.invalidPageSubmissions -= 1;
      const { RepositoryRunError } =
        await import("../../src/generation/errors.js");
      throw new RepositoryRunError(
        "invalid_input",
        "Unsupported evidence resource: src/agent/index.ts",
      );
    }
    const job = run.state.plan?.pages.find(({ id }) => id === input.jobId);
    if (!job) throw new Error("Expected the current harness page job.");
    job.status = "complete";
    return Promise.resolve({
      status: "complete",
      page: job.path,
      remaining: 0,
    });
  },
  async finishRepositoryRun(run: HarnessRun) {
    harness.finishCalls += 1;
    if (harness.driftOnce && harness.finishCalls === 1) {
      run.state.phase = "planning";
      delete run.state.plan;
      const { RepositoryRunError } =
        await import("../../src/generation/errors.js");
      throw new RepositoryRunError(
        "conflict",
        "Repository source changed during this OpenWiki run. The old plan was invalidated; call begin and submit a replacement plan.",
      );
    }
    return { status: "complete" };
  },
}));

import {
  parseWorkerToolEvent,
  runNativeRepositoryGeneration,
} from "../../src/agent/repository-runner.ts";
import type { OpenWikiRunEvent } from "../../src/agent/types.ts";

/**
 * Runs the native repository worker harness and captures public events.
 *
 * @returns Complete ordered event stream emitted by the runner.
 */
async function runHarness(): Promise<OpenWikiRunEvent[]> {
  const events: OpenWikiRunEvent[] = [];
  await runNativeRepositoryGeneration({
    root: "/repo",
    mode: "update",
    modelId: "test-model",
    model: {} as never,
    planningContext: "User and connector context",
    onEvent: (event) => events.push(event),
  });
  return events;
}

beforeEach(() => {
  harness.agentOptions = [];
  harness.beginCalls = 0;
  harness.changedPaths = ["README.md"];
  harness.currentRun = undefined;
  harness.driftOnce = false;
  harness.filesystemTools = [];
  harness.finishCalls = 0;
  harness.invalidPageSubmissions = 0;
  harness.invalidPlanSubmissions = 0;
  harness.noop = false;
  harness.pageSubmissionCalls = 0;
  harness.pageToolResults = [];
  harness.planSubmissionCalls = 0;
  harness.planToolResults = [];
  harness.planPaths = ["/openwiki/quickstart.md", "/openwiki/architecture.md"];
  harness.resumed = false;
});

describe("runNativeRepositoryGeneration", () => {
  test("uses exact shell-free tool surfaces and a fresh worker per page", async () => {
    const events = await runHarness();

    expect(harness.filesystemTools).toEqual([
      ["read_file", "ls", "glob", "grep"],
      ["read_file", "ls", "glob", "grep", "write_file", "edit_file"],
      ["read_file", "ls", "glob", "grep", "write_file", "edit_file"],
    ]);
    expect(harness.filesystemTools.flat()).not.toContain("execute");
    expect(harness.filesystemTools.flat()).not.toContain("task");
    expect(harness.agentOptions).toHaveLength(3);
    expect(harness.agentOptions.map(({ subagents }) => subagents)).toEqual([
      [],
      [],
      [],
    ]);
    expect(String(harness.agentOptions[0]?.systemPrompt)).toContain(
      "User and connector context",
    );
    expect(String(harness.agentOptions[1]?.systemPrompt)).toContain(
      "You own exactly /openwiki/quickstart.md",
    );
    expect(String(harness.agentOptions[2]?.systemPrompt)).toContain(
      "You own exactly /openwiki/architecture.md",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "repository_progress",
        stage: "generating",
        page: "/openwiki/architecture.md",
        pageIndex: 2,
        pageCount: 2,
      }),
    );
    expect(events.some((event) => event.type === "text")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_start", name: "write_file" }),
    );
  });

  test("maps a newly changed source path through planning into a new page job", async () => {
    harness.changedPaths = ["src/new-feature.ts"];
    harness.planPaths = ["/openwiki/new-feature.md"];

    await runHarness();

    expect(String(harness.agentOptions[0]?.systemPrompt)).toContain(
      "src/new-feature.ts",
    );
    expect(String(harness.agentOptions[1]?.systemPrompt)).toContain(
      "You own exactly /openwiki/new-feature.md",
    );
  });

  test("returns invalid page submissions as tool errors for correction and retry", async () => {
    harness.invalidPageSubmissions = 1;
    harness.planPaths = ["/openwiki/agent-runtime.md"];

    await expect(runHarness()).resolves.toBeDefined();

    expect(harness.pageSubmissionCalls).toBe(2);
    const [rejection] = harness.pageToolResults;
    expect(ToolMessage.isInstance(rejection)).toBe(true);
    if (!ToolMessage.isInstance(rejection)) {
      throw new Error("Expected submit_page to return a ToolMessage.");
    }
    expect(rejection.name).toBe("submit_page");
    expect(rejection.status).toBe("error");
    expect(rejection.tool_call_id).toBe("submit_page-invalid");
    expect(rejection.text).toContain(
      '"message":"Unsupported evidence resource: src/agent/index.ts"',
    );
    expect(rejection.text).toContain(
      '"retry":"Correct the assigned page or complete Claim payload and call submit_page again."',
    );
    expect(harness.finishCalls).toBe(1);
  });

  test("returns invalid plans as tool errors for correction and retry", async () => {
    harness.invalidPlanSubmissions = 1;
    harness.planPaths = ["/openwiki/quickstart.md"];

    await expect(runHarness()).resolves.toBeDefined();

    expect(harness.planSubmissionCalls).toBe(2);
    const [rejection] = harness.planToolResults;
    expect(ToolMessage.isInstance(rejection)).toBe(true);
    if (!ToolMessage.isInstance(rejection)) {
      throw new Error("Expected submit_plan to return a ToolMessage.");
    }
    expect(rejection.name).toBe("submit_plan");
    expect(rejection.status).toBe("error");
    expect(rejection.tool_call_id).toBe("submit_plan-invalid");
    expect(rejection.text).toContain(
      '"message":"Invalid or reserved OpenWiki page path: /openwiki/_plan.md"',
    );
    expect(rejection.text).toContain(
      '"retry":"Correct the plan and call submit_plan again."',
    );
    expect(harness.finishCalls).toBe(1);
  });

  test("filters DeepAgents' automatic task capability at the model boundary", async () => {
    await runHarness();
    const noDelegation = harness.agentOptions[0]?.middleware.at(-1);
    if (!noDelegation?.wrapModelCall) {
      throw new Error("Expected the no-delegation model-call middleware.");
    }
    const request = {
      tools: [{ name: "read_file" }, { name: "task" }, { name: "submit_plan" }],
    };
    const filtered = await noDelegation.wrapModelCall(request, (next) =>
      Promise.resolve(next),
    );

    expect(filtered.tools.map(({ name }) => name)).toEqual([
      "read_file",
      "submit_plan",
    ]);
  });

  test("resumes a durable queue without recreating the planner", async () => {
    harness.resumed = true;
    harness.currentRun = {
      root: "/repo",
      state: {
        phase: "generating",
        mode: "update",
        language: "en",
        plan: {
          pages: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              path: "/openwiki/resumed.md",
              title: "Resumed",
              purpose: "Resume work.",
              seedPaths: [],
              relatedPages: [],
              instructions: [],
              status: "pending",
            },
          ],
          deletePages: [],
        },
      },
    };

    const events = await runHarness();

    expect(harness.agentOptions).toHaveLength(1);
    expect(String(harness.agentOptions[0]?.systemPrompt)).toContain(
      "You own exactly /openwiki/resumed.md",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "repository_progress",
        stage: "generating",
        resumed: true,
      }),
    );
  });

  test("re-begins and replans after finish-time source drift", async () => {
    harness.driftOnce = true;
    harness.planPaths = ["/openwiki/quickstart.md"];

    const events = await runHarness();

    expect(harness.beginCalls).toBe(2);
    expect(harness.finishCalls).toBe(2);
    expect(harness.agentOptions).toHaveLength(4);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "repository_progress",
        stage: "replanning",
        resumed: true,
      }),
    );
    expect(
      events.filter(
        (event) =>
          event.type === "repository_progress" && event.stage === "planning",
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "repository_progress" && event.stage === "replanning",
      ),
    ).toHaveLength(2);
  });

  test("reports strict no-op without constructing a worker", async () => {
    harness.noop = true;

    const events = await runHarness();

    expect(harness.agentOptions).toHaveLength(0);
    expect(events).toEqual([{ type: "repository_progress", stage: "noop" }]);
  });
});

describe("parseWorkerToolEvent", () => {
  test("forwards only approved tool lifecycle events", () => {
    expect(
      parseWorkerToolEvent([
        [],
        "tools",
        {
          event: "on_tool_start",
          name: "read_file",
          toolCallId: "read-1",
          input: { path: "/README.md" },
        },
      ]),
    ).toMatchObject({ type: "tool_start", name: "read_file", id: "read-1" });
    expect(
      parseWorkerToolEvent([
        [],
        "tools",
        { event: "on_tool_start", name: "execute", toolCallId: "shell" },
      ]),
    ).toBeNull();
    expect(
      parseWorkerToolEvent([
        [],
        "tools",
        { event: "on_tool_start", name: "task", toolCallId: "delegate" },
      ]),
    ).toBeNull();
    expect(
      parseWorkerToolEvent([[], "messages", { text: "private narration" }]),
    ).toBeNull();
  });
});
