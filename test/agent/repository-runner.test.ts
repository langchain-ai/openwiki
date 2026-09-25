import {
  AIMessage,
  AIMessageChunk,
  ChatMessage,
  ChatMessageChunk,
  ToolMessage,
} from "@langchain/core/messages";
import { beforeEach, describe, expect, test, vi } from "vitest";

type HarnessPage = {
  id: string;
  path: string;
  title: string;
  purpose: string;
  seedPaths: string[];
  relatedPages: string[];
  instructions: string[];
  status: "pending" | "skipped" | "complete";
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
    handler: (request: ModelToolRequest) => Promise<unknown>,
  ) => Promise<unknown>;
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
  duplicatePlanSubmission: false,
  duplicatePlanToolResults: [] as unknown[],
  filesystemTools: [] as string[][],
  finishCalls: 0,
  invalidPageSubmissions: 0,
  invalidPlanSubmissions: 0,
  noop: false,
  pageSubmissionCalls: 0,
  pageToolResults: [] as unknown[],
  pageWorkerFailures: 0,
  pageWorkerFailureError: undefined as Error | undefined,
  pageGate: undefined as Promise<void> | undefined,
  gatedPage: undefined as string | undefined,
  fatalPageSubmissions: [] as string[],
  nextPageCalls: 0,
  nextPageGate: undefined as Promise<void> | undefined,
  nextPageGateAfter: Number.POSITIVE_INFINITY,
  pageWorkerPostSubmitFailures: 0,
  planSubmissionCalls: 0,
  planToolResults: [] as unknown[],
  planPaths: ["/openwiki/quickstart.md", "/openwiki/architecture.md"],
  resumed: false,
  restoreCalls: 0,
  workerExitsWithoutSubmit: false,
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
      const completionTool = options.tools.find(({ name }) =>
        ["submit_plan", "submit_page"].includes(name),
      );
      if (!completionTool) {
        throw new Error("Expected one repository completion tool.");
      }
      const toolName = completionTool.name;
      if (toolName !== "submit_plan" && toolName !== "submit_page") {
        throw new Error(`Unexpected completion tool: ${toolName}`);
      }
      const page =
        toolName === "submit_page"
          ? String(options.systemPrompt).match(
              /You own exactly ([^\n]+)\./u,
            )?.[1]
          : undefined;
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

            if (
              toolName === "submit_page" &&
              harness.pageGate &&
              (harness.gatedPage === undefined || harness.gatedPage === page)
            ) {
              await harness.pageGate;
            }

            if (toolName === "submit_page" && harness.pageWorkerFailures > 0) {
              harness.pageWorkerFailures -= 1;
              throw (
                harness.pageWorkerFailureError ??
                new Error("injected page worker failure")
              );
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
            const exitWithoutSubmit =
              toolName === "submit_page" && harness.workerExitsWithoutSubmit;
            if (exitWithoutSubmit) {
              harness.workerExitsWithoutSubmit = false;
            } else {
              await completionTool.invoke(input);
              if (
                toolName === "submit_plan" &&
                harness.duplicatePlanSubmission
              ) {
                const duplicate = await completionTool.invoke(input);
                harness.duplicatePlanToolResults.push(duplicate);
              }
              if (
                toolName === "submit_page" &&
                harness.pageWorkerPostSubmitFailures > 0
              ) {
                harness.pageWorkerPostSubmitFailures -= 1;
                throw new Error("injected post-submit worker failure");
              }
            }
          },
        }),
      );
      return { stream };
    },
  };
});

vi.mock("../../src/generation/repository-run.js", () => ({
  captureRepositoryPageSnapshot(_run: HarnessRun, jobId: string) {
    return Promise.resolve({
      jobId,
      path: "/openwiki/snapshot.md",
      markdown: "original\n",
      claims: null,
    });
  },
  skipRepositoryPage(run: HarnessRun, snapshot: { jobId: string }) {
    harness.restoreCalls += 1;
    const job = run.state.plan?.pages.find(({ id }) => id === snapshot.jobId);
    if (!job) throw new Error("Expected skipped harness page job.");
    job.status = "skipped";
    return Promise.resolve();
  },
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
        pageUpdateWindows: [
          {
            pages: [],
            changedPaths: [...harness.changedPaths],
            fullReview: true,
          },
        ],
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
    if (run.state.plan) {
      const proposed = {
        pages: input.pages.map((page) => ({
          path: page.path,
          title: page.title,
          purpose: page.purpose,
          seedPaths: [],
          relatedPages: [],
          instructions: page.instructions ?? [],
        })),
        deletePages: input.deletePages ?? [],
      };
      const current = {
        pages: run.state.plan.pages.map(
          ({
            path,
            title,
            purpose,
            seedPaths,
            relatedPages,
            instructions,
          }) => ({
            path,
            title,
            purpose,
            seedPaths,
            relatedPages,
            instructions,
          }),
        ),
        deletePages: run.state.plan.deletePages,
      };
      if (JSON.stringify(proposed) !== JSON.stringify(current)) {
        const { RepositoryRunError } =
          await import("../../src/generation/errors.js");
        throw new RepositoryRunError(
          "invalid_state",
          "This OpenWiki run already has a different persisted plan.",
        );
      }
      return Promise.resolve({
        status: "accepted",
        totalPages: run.state.plan.pages.length,
      });
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
  nextRepositoryPage(
    run: HarnessRun,
    options: { exclude?: ReadonlySet<string> } = {},
  ) {
    harness.nextPageCalls += 1;
    const next = () => {
      const exclude = options.exclude ?? new Set<string>();
      const job = run.state.plan?.pages.find(
        ({ id, status }) => status === "pending" && !exclude.has(id),
      );
      return job
        ? {
            status: "pending" as const,
            job: {
              ...job,
              mode: run.state.mode,
              existing: false,
              existingClaimCount: 0,
              claimsRequiringAttention: [],
            },
          }
        : { status: "complete" as const };
    };
    if (
      harness.nextPageGate !== undefined &&
      harness.nextPageCalls >= harness.nextPageGateAfter
    ) {
      return harness.nextPageGate.then(next);
    }
    return Promise.resolve(next());
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
    if (harness.fatalPageSubmissions.includes(job.path)) {
      const { RepositoryRunError } =
        await import("../../src/generation/errors.js");
      throw new RepositoryRunError(
        "invalid_state",
        `injected fatal submission failure for ${job.path}`,
      );
    }
    job.status = "complete";
    return Promise.resolve({
      status: "complete",
      page: job.path,
      remaining: 0,
    });
  },
  finishRepositoryRun() {
    harness.finishCalls += 1;
    if (harness.driftOnce && harness.finishCalls === 1) {
      return { status: "complete", sourceChanged: true };
    }
    return { status: "complete" };
  },
}));

import {
  isRateLimitError,
  parseWorkerToolEvent,
  runNativeRepositoryGeneration,
} from "../../src/agent/repository-runner.ts";
import type { OpenWikiRunEvent } from "../../src/agent/types.ts";

/**
 * Runs the native repository worker harness and captures public events.
 *
 * @returns Complete ordered event stream emitted by the runner.
 */
async function runHarness(
  options: { pageConcurrency?: number } = {},
): Promise<OpenWikiRunEvent[]> {
  const events: OpenWikiRunEvent[] = [];
  await runNativeRepositoryGeneration({
    root: "/repo",
    mode: "update",
    modelId: "test-model",
    model: {} as never,
    planningContext: "User and connector context",
    onEvent: (event) => events.push(event),
    ...(options.pageConcurrency === undefined
      ? {}
      : {
          pageConcurrency: options.pageConcurrency,
          workerStartStaggerMs: 0,
        }),
  });
  return events;
}

/**
 * Creates a gate that holds every page worker before its submission.
 *
 * @returns The gate promise installed on the harness and its release.
 */
function holdPageWorkers(page?: string): () => void {
  let release: () => void = () => undefined;
  harness.pageGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  harness.gatedPage = page;
  return () => {
    release();
    harness.pageGate = undefined;
    harness.gatedPage = undefined;
  };
}

function holdNextPageAcquisition(after: number): () => void {
  let release: () => void = () => undefined;
  harness.nextPageGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  harness.nextPageGateAfter = after;
  return () => {
    release();
    harness.nextPageGate = undefined;
    harness.nextPageGateAfter = Number.POSITIVE_INFINITY;
  };
}

function pagePrompt(index: number): string {
  return String(harness.agentOptions[index]?.systemPrompt);
}

async function getNoDelegationWrapModelCall(): Promise<
  NonNullable<CapturedMiddleware["wrapModelCall"]>
> {
  await runHarness();
  const wrapModelCall =
    harness.agentOptions[0]?.middleware.at(-1)?.wrapModelCall;
  if (!wrapModelCall) {
    throw new Error("Expected the no-delegation model-call middleware.");
  }
  return wrapModelCall;
}

beforeEach(() => {
  harness.agentOptions = [];
  harness.beginCalls = 0;
  harness.changedPaths = ["README.md"];
  harness.currentRun = undefined;
  harness.driftOnce = false;
  harness.duplicatePlanSubmission = false;
  harness.duplicatePlanToolResults = [];
  harness.filesystemTools = [];
  harness.finishCalls = 0;
  harness.invalidPageSubmissions = 0;
  harness.invalidPlanSubmissions = 0;
  harness.noop = false;
  harness.pageSubmissionCalls = 0;
  harness.pageToolResults = [];
  harness.pageWorkerFailures = 0;
  harness.pageWorkerFailureError = undefined;
  harness.pageGate = undefined;
  harness.gatedPage = undefined;
  harness.fatalPageSubmissions = [];
  harness.nextPageCalls = 0;
  harness.nextPageGate = undefined;
  harness.nextPageGateAfter = Number.POSITIVE_INFINITY;
  harness.pageWorkerPostSubmitFailures = 0;
  harness.planSubmissionCalls = 0;
  harness.planToolResults = [];
  harness.planPaths = ["/openwiki/quickstart.md", "/openwiki/architecture.md"];
  harness.resumed = false;
  harness.restoreCalls = 0;
  harness.workerExitsWithoutSubmit = false;
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
    expect(harness.agentOptions[1]?.tools.map(({ name }) => name)).toEqual([
      "inspect_claims",
      "submit_page",
    ]);
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
      '"retry":"Correct the assigned page or sparse Claim decisions and call submit_page again."',
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

  test("continues when the planner repeats the same accepted plan", async () => {
    harness.duplicatePlanSubmission = true;
    harness.planPaths = ["/openwiki/quickstart.md"];

    await expect(runHarness()).resolves.toBeDefined();

    expect(harness.planSubmissionCalls).toBe(2);
    expect(harness.duplicatePlanToolResults).toEqual([
      '{"status":"accepted","totalPages":1}',
    ]);
    expect(harness.pageSubmissionCalls).toBe(1);
    expect(harness.currentRun?.state.plan?.pages[0]?.status).toBe("complete");
    expect(harness.finishCalls).toBe(1);
  });

  test("skips a failed page worker and continues the queue", async () => {
    harness.pageWorkerFailures = 1;
    harness.planPaths = ["/openwiki/failed.md", "/openwiki/later.md"];

    await expect(runHarness()).resolves.toBeDefined();

    expect(harness.restoreCalls).toBe(1);
    expect(harness.currentRun?.state.plan?.pages[0]?.status).toBe("skipped");
    expect(harness.currentRun?.state.plan?.pages[1]?.status).toBe("complete");
    expect(harness.finishCalls).toBe(1);
  });

  test("keeps a durably completed page after a later worker failure", async () => {
    harness.pageWorkerPostSubmitFailures = 1;
    harness.planPaths = ["/openwiki/completed.md"];

    await expect(runHarness()).resolves.toBeDefined();

    expect(harness.restoreCalls).toBe(0);
    expect(harness.currentRun?.state.plan?.pages[0]?.status).toBe("complete");
    expect(harness.finishCalls).toBe(1);
  });

  test("filters DeepAgents' automatic task capability at the model boundary", async () => {
    const wrapModelCall = await getNoDelegationWrapModelCall();
    const request = {
      tools: [{ name: "read_file" }, { name: "task" }, { name: "submit_plan" }],
    };
    const filtered = await wrapModelCall(request, (next) =>
      Promise.resolve(next),
    );

    expect(
      (filtered as ModelToolRequest).tools.map(({ name }) => name),
    ).toEqual(["read_file", "submit_plan"]);
  });

  test("coerces roleless generic streaming aggregates before LangChain validates wrapModelCall", async () => {
    const wrapModelCall = await getNoDelegationWrapModelCall();
    const request = {
      tools: [{ name: "read_file" }, { name: "task" }, { name: "submit_plan" }],
    };
    const genericAggregate = new ChatMessageChunk({
      additional_kwargs: {
        reasoning_content: "thinking before assistant role",
        tool_calls: [
          {
            id: "call_submit_plan",
            index: 0,
            function: {
              name: "submit_plan",
              arguments: '{"pages":[]}',
            },
          },
        ],
      },
      content: "planning complete",
      response_metadata: { model_provider: "openai" },
      role: undefined as unknown as string,
    });

    const coerced = await wrapModelCall(request, (next) => {
      expect(next.tools.map(({ name }) => name)).toEqual([
        "read_file",
        "submit_plan",
      ]);
      return Promise.resolve(genericAggregate);
    });

    expect(AIMessage.isInstance(coerced)).toBe(true);
    expect(coerced).toBeInstanceOf(AIMessageChunk);
    const aiResponse = coerced as AIMessageChunk;
    expect(aiResponse.text).toBe("planning complete");
    expect(aiResponse.additional_kwargs.reasoning_content).toBe(
      "thinking before assistant role",
    );
    expect(aiResponse.tool_calls).toEqual([
      {
        args: { pages: [] },
        id: "call_submit_plan",
        name: "submit_plan",
        type: "tool_call",
      },
    ]);
  });

  test("coerces generic assistant messages before LangChain validates wrapModelCall", async () => {
    const wrapModelCall = await getNoDelegationWrapModelCall();
    const genericMessage = new ChatMessage({
      additional_kwargs: {
        tool_calls: [
          {
            id: "call_submit_plan",
            function: {
              name: "submit_plan",
              arguments: '{"pages":[]}',
            },
          },
        ],
      },
      content: "planning complete",
      role: "assistant",
    });

    const coerced = await wrapModelCall({ tools: [] }, () =>
      Promise.resolve(genericMessage),
    );

    expect(AIMessage.isInstance(coerced)).toBe(true);
    expect(coerced).toBeInstanceOf(AIMessage);
    const aiResponse = coerced as AIMessage;
    expect(aiResponse.text).toBe("planning complete");
    expect(aiResponse.tool_calls).toEqual([
      {
        args: { pages: [] },
        id: "call_submit_plan",
        name: "submit_plan",
      },
    ]);
  });

  test("leaves non-assistant generic model responses untouched", async () => {
    const wrapModelCall = await getNoDelegationWrapModelCall();
    const genericUserResponse = new ChatMessageChunk({
      content: "not assistant output",
      role: "user",
    });
    const response = await wrapModelCall({ tools: [] }, () =>
      Promise.resolve(genericUserResponse),
    );

    expect(response).toBe(genericUserResponse);
    expect(AIMessage.isInstance(response)).toBe(false);
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

  test("finalizes once and warns after finish-time source drift", async () => {
    harness.driftOnce = true;
    harness.planPaths = ["/openwiki/quickstart.md"];

    const events = await runHarness();

    expect(harness.beginCalls).toBe(1);
    expect(harness.finishCalls).toBe(1);
    expect(harness.agentOptions).toHaveLength(2);
    expect(
      events.filter(
        (event) =>
          event.type === "repository_progress" && event.stage === "planning",
      ),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "text" &&
          event.text.includes("finalized without advancing"),
      ),
    ).toBe(true);
  });

  test("restores and leaves a page pending when its worker does not submit", async () => {
    harness.workerExitsWithoutSubmit = true;
    harness.planPaths = ["/openwiki/testing.md", "/openwiki/later.md"];

    const events = await runHarness();

    expect(harness.restoreCalls).toBe(1);
    expect(harness.finishCalls).toBe(1);
    expect(harness.currentRun?.state.plan?.pages[0]?.status).toBe("skipped");
    expect(harness.currentRun?.state.plan?.pages[1]?.status).toBe("complete");
    expect(harness.agentOptions).toHaveLength(3);
    expect(
      events.some(
        (event) =>
          event.type === "text" &&
          event.text.includes("reconsidered on the next update"),
      ),
    ).toBe(true);
  });

  test("reports strict no-op without constructing a worker", async () => {
    harness.noop = true;

    const events = await runHarness();

    expect(harness.agentOptions).toHaveLength(0);
    expect(events).toEqual([{ type: "repository_progress", stage: "noop" }]);
  });
});

describe("runNativeRepositoryGeneration with concurrent page workers", () => {
  test("keeps the sequential event shape when concurrency is one", async () => {
    const events = await runHarness({ pageConcurrency: 1 });

    const progress = events.filter(
      (event) =>
        event.type === "repository_progress" && event.stage === "generating",
    );
    expect(progress).toHaveLength(2);
    for (const event of progress) {
      expect(event).not.toHaveProperty("inFlightPages");
      expect(event).not.toHaveProperty("completedCount");
    }
  });

  test("runs distinct pages at once and writes quickstart last", async () => {
    harness.planPaths = [
      "/openwiki/quickstart.md",
      "/openwiki/a.md",
      "/openwiki/b.md",
      "/openwiki/c.md",
      "/openwiki/d.md",
    ];
    const release = holdPageWorkers();

    const running = runHarness({ pageConcurrency: 3 });
    await vi.waitFor(() => expect(harness.agentOptions).toHaveLength(4));

    // Planner plus three page workers exist before any page is submitted, and
    // none of them owns quickstart.
    expect(harness.pageSubmissionCalls).toBe(0);
    const firstWave = [1, 2, 3].map(
      (index) => pagePrompt(index).match(/You own exactly ([^\n]+)\./u)?.[1],
    );
    expect(new Set(firstWave).size).toBe(3);
    expect(firstWave).not.toContain("/openwiki/quickstart.md");

    release();
    const events = await running;

    expect(harness.agentOptions).toHaveLength(6);
    expect(pagePrompt(5)).toContain("You own exactly /openwiki/quickstart.md");
    expect(
      harness.currentRun?.state.plan?.pages.map(({ status }) => status),
    ).toEqual(["complete", "complete", "complete", "complete", "complete"]);
    expect(harness.finishCalls).toBe(1);

    const inFlightCounts = events
      .filter(
        (
          event,
        ): event is Extract<
          OpenWikiRunEvent,
          { type: "repository_progress" }
        > => event.type === "repository_progress",
      )
      .map((event) => event.inFlightPages?.length ?? 0);
    expect(Math.max(...inFlightCounts)).toBe(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "repository_progress",
        stage: "generating",
        page: "/openwiki/quickstart.md",
        completedCount: 4,
        inFlightPages: ["/openwiki/quickstart.md"],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_start",
        name: "write_file",
        page: "/openwiki/a.md",
      }),
    );
    expect(
      events.some(
        (event) =>
          (event.type === "tool_start" || event.type === "tool_end") &&
          event.name === "read_file" &&
          event.page === undefined,
      ),
    ).toBe(true);
  });

  test("lowers concurrency after a rate-limited worker and continues", async () => {
    harness.planPaths = [
      "/openwiki/a.md",
      "/openwiki/b.md",
      "/openwiki/c.md",
      "/openwiki/d.md",
      "/openwiki/e.md",
    ];
    harness.pageWorkerFailures = 1;
    harness.pageWorkerFailureError = Object.assign(
      new Error("Request failed with status code 429"),
      { status: 429 },
    );

    const events = await runHarness({ pageConcurrency: 3 });

    // Which of the first three concurrent workers reaches the injected
    // failure first depends on scheduling, so assert on counts, not positions.
    expect(harness.restoreCalls).toBe(1);
    const statuses =
      harness.currentRun?.state.plan?.pages.map(({ status }) => status) ?? [];
    expect(statuses.filter((status) => status === "skipped")).toHaveLength(1);
    expect(statuses.filter((status) => status === "complete")).toHaveLength(4);
    expect(harness.finishCalls).toBe(1);
    expect(
      events.filter(
        (event) =>
          event.type === "text" &&
          event.text.includes("Reduced page concurrency to 2"),
      ),
    ).toHaveLength(1);
  });

  test("does not lower concurrency for an ordinary worker failure", async () => {
    harness.planPaths = ["/openwiki/a.md", "/openwiki/b.md", "/openwiki/c.md"];
    harness.pageWorkerFailures = 1;

    const events = await runHarness({ pageConcurrency: 2 });

    expect(harness.restoreCalls).toBe(1);
    expect(harness.finishCalls).toBe(1);
    expect(
      events.some(
        (event) =>
          event.type === "text" &&
          event.text.includes("Reduced page concurrency"),
      ),
    ).toBe(false);
  });

  test("lets in-flight workers settle before rethrowing a fatal submission", async () => {
    harness.planPaths = ["/openwiki/fatal.md", "/openwiki/other.md"];
    harness.fatalPageSubmissions = ["/openwiki/fatal.md"];
    const release = holdPageWorkers();

    const running = runHarness({ pageConcurrency: 2 });
    await vi.waitFor(() => expect(harness.agentOptions).toHaveLength(3));
    release();

    await expect(running).rejects.toThrow(
      "injected fatal submission failure for /openwiki/fatal.md",
    );
    expect(harness.finishCalls).toBe(0);
    expect(harness.restoreCalls).toBe(0);
    expect(
      harness.currentRun?.state.plan?.pages.map(({ path, status }) => [
        path,
        status,
      ]),
    ).toEqual([
      ["/openwiki/fatal.md", "pending"],
      ["/openwiki/other.md", "complete"],
    ]);
  });

  test("does not start a newly acquired page after a sibling fails fatally", async () => {
    harness.planPaths = [
      "/openwiki/fatal.md",
      "/openwiki/other.md",
      "/openwiki/later.md",
    ];
    harness.fatalPageSubmissions = ["/openwiki/fatal.md"];
    const releaseFatal = holdPageWorkers("/openwiki/fatal.md");
    // The third acquisition belongs to the worker that completed `other`.
    const releaseAcquisition = holdNextPageAcquisition(3);

    const running = runHarness({ pageConcurrency: 2 });
    await vi.waitFor(() => expect(harness.agentOptions).toHaveLength(3));
    await vi.waitFor(() => expect(harness.nextPageCalls).toBe(3));

    releaseFatal();
    await vi.waitFor(() => expect(harness.pageSubmissionCalls).toBe(2));
    releaseAcquisition();

    await expect(running).rejects.toThrow(
      "injected fatal submission failure for /openwiki/fatal.md",
    );
    expect(harness.agentOptions).toHaveLength(3);
    expect(
      harness.currentRun?.state.plan?.pages.map(({ path, status }) => [
        path,
        status,
      ]),
    ).toEqual([
      ["/openwiki/fatal.md", "pending"],
      ["/openwiki/other.md", "complete"],
      ["/openwiki/later.md", "pending"],
    ]);
  });
});

describe("isRateLimitError", () => {
  test("recognizes status fields, codes, messages, and causes", () => {
    expect(
      isRateLimitError(Object.assign(new Error("x"), { status: 429 })),
    ).toBe(true);
    expect(
      isRateLimitError(Object.assign(new Error("x"), { statusCode: 429 })),
    ).toBe(true);
    expect(
      isRateLimitError(
        Object.assign(new Error("x"), { code: "rate_limit_exceeded" }),
      ),
    ).toBe(true);
    expect(isRateLimitError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRateLimitError(new Error("Rate limit reached for gpt"))).toBe(
      true,
    );
    expect(
      isRateLimitError(
        new Error("wrapped", {
          cause: Object.assign(new Error("inner"), { status: 429 }),
        }),
      ),
    ).toBe(true);
  });

  test("ignores unrelated failures and non-objects", () => {
    expect(isRateLimitError(new Error("injected page worker failure"))).toBe(
      false,
    );
    expect(
      isRateLimitError(Object.assign(new Error("x"), { status: 500 })),
    ).toBe(false);
    expect(isRateLimitError("429")).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
    const circular: { cause?: unknown; message: string } = { message: "loop" };
    circular.cause = circular;
    expect(isRateLimitError(circular)).toBe(false);
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
