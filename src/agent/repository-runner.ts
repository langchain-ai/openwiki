import { scheduler } from "node:timers/promises";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ToolMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { RepositoryRunError } from "../generation/errors.js";
import {
  beginRepositoryRun,
  finishRepositoryRun,
  nextRepositoryPage,
  submitRepositoryPage,
  submitRepositoryPlan,
  type ActiveBeginView,
  type ActiveRepositoryRun,
  type BeginRepositoryRunResult,
  type NextRepositoryPageResult,
} from "../generation/repository-run.js";
import type { RepositoryRunMode } from "../generation/run-state.js";
import { OPENWIKI_PRODUCER_ACTOR } from "../version.js";
import {
  AGENT_FILESYSTEM_PERMISSIONS,
  createAgentBackend,
} from "./agent-backend.js";
import { OpenWikiLocalShellBackend } from "./docs-only-backend.js";
import { OpenWikiIgnore } from "./openwiki-ignore.js";
import {
  createRepositoryPagePrompt,
  createRepositoryPlannerPrompt,
} from "./repository-prompts.js";
import type { OpenWikiRunEvent } from "./types.js";

const PlanPageSchema = z
  .object({
    path: z.string().trim().min(1),
    title: z.string().trim().min(1),
    purpose: z.string().trim().min(1),
    seedPaths: z.array(z.string().trim().min(1)).optional(),
    relatedPages: z.array(z.string().trim().min(1)).optional(),
    instructions: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

const PlanSchema = z
  .object({
    pages: z.array(PlanPageSchema),
    deletePages: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

const ClaimSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    statement: z.string().trim().min(1),
    evidence: z
      .array(z.object({ resource: z.string().trim().min(1) }).strict())
      .min(1),
  })
  .strict();

const PLANNER_FILESYSTEM_TOOLS = ["read_file", "ls", "glob", "grep"] as const;
const PAGE_FILESYSTEM_TOOLS = [
  ...PLANNER_FILESYSTEM_TOOLS,
  "write_file",
  "edit_file",
] as const;
const WORKER_TOOL_NAMES = new Set<string>([
  ...PAGE_FILESYSTEM_TOOLS,
  "submit_plan",
  "submit_page",
]);

// DeepAgents 1.12 adds a general-purpose task tool even when subagents is
// empty. Repository workers are deliberately non-delegating, so remove that
// model-facing capability after all tool-contributing middleware has run.
const NO_DELEGATION_MIDDLEWARE = createMiddleware({
  name: "OpenWikiRepositoryWorkerNoDelegation",
  wrapModelCall: (request, handler) =>
    handler({
      ...request,
      tools: request.tools?.filter(({ name }) => name !== "task"),
    }),
});

type PendingPageJob = Extract<
  NextRepositoryPageResult,
  { status: "pending" }
>["job"];

/**
 * Converts a correctable submission rejection into a failed tool result.
 *
 * @param toolName - Completion tool that rejected the model payload.
 * @param error - Validated repository input error returned by the lifecycle.
 * @param retry - Concrete correction instruction shown to the worker.
 * @param toolCallId - LangChain identifier for the active tool call.
 * @returns Error-status tool message that keeps the worker loop active.
 */
function createSubmissionRejection(
  toolName: "submit_plan" | "submit_page",
  error: RepositoryRunError,
  retry: string,
  toolCallId: string | undefined,
): ToolMessage {
  if (!toolCallId) {
    throw new Error(`${toolName} rejection requires an active tool call id.`);
  }

  return new ToolMessage({
    name: toolName,
    tool_call_id: toolCallId,
    status: "error",
    content: JSON.stringify({
      status: "rejected",
      code: error.code,
      message: error.message,
      retry,
    }),
  });
}

/**
 * Inputs for one native repository-generation command.
 */
export interface NativeRepositoryGenerationOptions {
  /**
   * Absolute Git repository root owned by the run.
   */
  root: string;

  /**
   * Repository generation command to execute or resume.
   */
  mode: RepositoryRunMode;

  /**
   * Requested output language, resolved by the durable lifecycle.
   */
  language?: string | null;

  /**
   * Whether strict update no-op detection must be bypassed.
   */
  force?: boolean;

  /**
   * Actual user and connector context supplied to planning and replanning.
   */
  planningContext?: string | null;

  /**
   * Stable model identity written to repository run metadata.
   */
  modelId: string;

  /**
   * Initialized chat model reused by fresh planner and page workers.
   */
  model: BaseChatModel;

  /**
   * Optional lifecycle and bounded worker-tool event consumer.
   */
  onEvent?: (event: OpenWikiRunEvent) => void;
}

/**
 * Observable result of one native repository-generation command.
 */
export interface NativeRepositoryGenerationResult {
  /**
   * Whether strict preflight proved that an update required no generation.
   */
  skipped: boolean;
}

/**
 * Drives the shared lifecycle with one planner and one fresh agent per page.
 *
 * The supplied model is reused, but no repository-generation checkpointer or
 * worker state survives beyond the durable core.
 *
 * @param options - Repository, model, planning context, and event consumer.
 * @returns Whether the command completed through the strict no-op path.
 */
export async function runNativeRepositoryGeneration(
  options: NativeRepositoryGenerationOptions,
): Promise<NativeRepositoryGenerationResult> {
  let begun = await beginNativeRepositoryRun(options);
  let replanningAfterSourceDrift = false;

  while (true) {
    if (!("run" in begun)) {
      options.onEvent?.({ type: "repository_progress", stage: "noop" });
      return { skipped: true };
    }

    const { run, view } = begun;
    if (run.state.phase === "planning") {
      options.onEvent?.({
        type: "repository_progress",
        stage: replanningAfterSourceDrift ? "replanning" : "planning",
        resumed: view.resumed,
      });
      await runPlanningAgent(
        run,
        view,
        options.model,
        run.state.planningContext,
        options.onEvent,
      );
    }

    await runPendingPageAgents(run, options.model, options.onEvent, view);
    options.onEvent?.({
      type: "repository_progress",
      stage: "finalizing",
      resumed: view.resumed,
      pageCount: run.state.plan?.pages.length,
    });

    try {
      await finishRepositoryRun(run);
      return { skipped: false };
    } catch (error) {
      if (!isSourceDriftInvalidation(error)) {
        throw error;
      }

      options.onEvent?.({
        type: "repository_progress",
        stage: "replanning",
        resumed: true,
      });
      replanningAfterSourceDrift = true;
      begun = await beginNativeRepositoryRun(options);
    }
  }
}

/**
 * Begins or reconstructs the durable lifecycle with a stable producer actor.
 *
 * @param options - Native runner options preserved across source-drift replans.
 * @returns Active or strict no-op begin result.
 */
async function beginNativeRepositoryRun(
  options: NativeRepositoryGenerationOptions,
): Promise<BeginRepositoryRunResult> {
  return beginRepositoryRun({
    root: options.root,
    mode: options.mode,
    language: options.language ?? undefined,
    force: options.force,
    planningContext: options.planningContext ?? undefined,
    actor: {
      producerActor: OPENWIKI_PRODUCER_ACTOR,
      metadataModel: options.modelId,
    },
  });
}

/**
 * Runs one bounded planner that must submit exactly one durable plan.
 *
 * @param run - Active durable repository run.
 * @param view - Current host-facing planning context.
 * @param model - Initialized model used only for this worker.
 * @param planningContext - Actual user and connector planning context.
 * @param onEvent - Optional bounded worker event consumer.
 */
async function runPlanningAgent(
  run: ActiveRepositoryRun,
  view: ActiveBeginView,
  model: BaseChatModel,
  planningContext?: string,
  onEvent?: (event: OpenWikiRunEvent) => void,
): Promise<void> {
  const ignore = await OpenWikiIgnore.load(run.root);
  const wikiBackend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    writableWikiPages: [],
    openWikiIgnore: ignore,
    maxOutputBytes: 100_000,
    outputMode: "repository",
    rootDir: run.root,
    timeout: 120,
    virtualMode: true,
  });

  let submitted = false;
  const submitPlanTool = new DynamicStructuredTool({
    name: "submit_plan",
    description:
      "Submit the final canonical OpenWiki page plan. This is the only completion action for planning.",
    schema: PlanSchema,
    func: async (input, _runManager, config) => {
      if (submitted) {
        throw new Error(
          "submit_plan was already called for this planning worker.",
        );
      }
      try {
        const result = await submitRepositoryPlan(run, input);
        submitted = true;
        return JSON.stringify(result);
      } catch (error) {
        if (
          error instanceof RepositoryRunError &&
          error.code === "invalid_input"
        ) {
          return createSubmissionRejection(
            "submit_plan",
            error,
            "Correct the plan and call submit_plan again.",
            (config as { toolCall?: { id?: string } } | undefined)?.toolCall
              ?.id,
          );
        }
        throw error;
      }
    },
  });

  const backend = createAgentBackend(wikiBackend);
  const agent = createDeepAgent({
    model,
    tools: [submitPlanTool],
    backend,
    middleware: [
      createFilesystemMiddleware({
        backend,
        permissions: AGENT_FILESYSTEM_PERMISSIONS,
        tools: PLANNER_FILESYSTEM_TOOLS,
      }),
      NO_DELEGATION_MIDDLEWARE,
    ],
    skills: ["/skills/"],
    subagents: [],
    permissions: AGENT_FILESYSTEM_PERMISSIONS,
    systemPrompt: createRepositoryPlannerPrompt(view, planningContext),
  });

  await streamWorkerTools(
    agent,
    [{ role: "user", content: "Plan this repository wiki now." }],
    onEvent,
  );

  if (!submitted || !run.state.plan) {
    throw new Error("Repository planning worker exited without submit_plan.");
  }
}

/**
 * Runs every remaining ordered page job with a fresh bounded worker.
 *
 * @param run - Active run containing the persisted queue.
 * @param model - Initialized model reused across fresh workers.
 * @param onEvent - Optional lifecycle and tool-event consumer.
 * @param view - Begin view used to retain resume state in progress events.
 */
async function runPendingPageAgents(
  run: ActiveRepositoryRun,
  model: BaseChatModel,
  onEvent: ((event: OpenWikiRunEvent) => void) | undefined,
  view: ActiveBeginView,
): Promise<void> {
  while (true) {
    const next = await nextRepositoryPage(run);
    if (next.status === "complete") return;

    const pages = run.state.plan?.pages ?? [];
    const pageIndex = pages.findIndex(({ id }) => id === next.job.id) + 1;
    onEvent?.({
      type: "repository_progress",
      stage: "generating",
      resumed: view.resumed,
      page: next.job.path,
      pageIndex,
      pageCount: pages.length,
    });
    await runPageAgent(run, next.job, model, onEvent);
  }
}

/**
 * Runs one shell-free worker bounded to its assigned page and Claim submission.
 *
 * @param run - Active durable repository run.
 * @param job - Current pending ordered page job.
 * @param model - Initialized model used only for this worker.
 * @param onEvent - Optional bounded worker event consumer.
 */
async function runPageAgent(
  run: ActiveRepositoryRun,
  job: PendingPageJob,
  model: BaseChatModel,
  onEvent?: (event: OpenWikiRunEvent) => void,
): Promise<void> {
  const ignore = await OpenWikiIgnore.load(run.root);
  const wikiBackend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    writableWikiPages: [job.path],
    openWikiIgnore: ignore,
    maxOutputBytes: 100_000,
    outputMode: "repository",
    rootDir: run.root,
    timeout: 120,
    virtualMode: true,
  });

  let submitted = false;
  const submitPageTool = new DynamicStructuredTool({
    name: "submit_page",
    description:
      "Complete the assigned page after writing it by submitting its complete intended material Claim set. Every evidence resource must use repo://<repository-relative-path>, optionally with #Lx-Ly.",
    schema: z.object({ claims: z.array(ClaimSchema).min(1) }).strict(),
    func: async ({ claims }, _runManager, config) => {
      if (submitted) {
        throw new Error("submit_page was already called for this page worker.");
      }
      try {
        const result = await submitRepositoryPage(run, {
          jobId: job.id,
          claims,
        });
        submitted = true;
        return JSON.stringify(result);
      } catch (error) {
        if (
          error instanceof RepositoryRunError &&
          error.code === "invalid_input"
        ) {
          return createSubmissionRejection(
            "submit_page",
            error,
            "Correct the assigned page or complete Claim payload and call submit_page again.",
            (config as { toolCall?: { id?: string } } | undefined)?.toolCall
              ?.id,
          );
        }
        throw error;
      }
    },
  });

  const backend = createAgentBackend(wikiBackend);
  const agent = createDeepAgent({
    model,
    tools: [submitPageTool],
    backend,
    middleware: [
      createFilesystemMiddleware({
        backend,
        permissions: AGENT_FILESYSTEM_PERMISSIONS,
        tools: PAGE_FILESYSTEM_TOOLS,
      }),
      NO_DELEGATION_MIDDLEWARE,
    ],
    skills: ["/skills/"],
    subagents: [],
    permissions: AGENT_FILESYSTEM_PERMISSIONS,
    systemPrompt: createRepositoryPagePrompt(
      job,
      run.state.plan?.pages ?? [],
      run.state.language,
    ),
  });

  await streamWorkerTools(
    agent,
    [
      {
        role: "user",
        content: "Research and document the assigned page, then submit it.",
      },
    ],
    onEvent,
  );

  if (!submitted) {
    throw new Error(`${job.path} worker exited without submit_page.`);
  }
}

/**
 * Streams only bounded worker tool lifecycle events, never worker narration.
 *
 * @param agent - Fresh planner or page agent.
 * @param messages - Single worker instruction message.
 * @param onEvent - Optional CLI event consumer.
 */
async function streamWorkerTools(
  agent: ReturnType<typeof createDeepAgent>,
  messages: Array<{ role: "user"; content: string }>,
  onEvent?: (event: OpenWikiRunEvent) => void,
): Promise<void> {
  const stream = await agent.stream(
    { messages },
    { streamMode: ["tools"], subgraphs: true },
  );

  for await (const chunk of stream) {
    const event = parseWorkerToolEvent(chunk);
    if (!event) continue;
    onEvent?.(event);
    await scheduler.yield();
  }
}

/**
 * Normalizes a DeepAgents tools-stream chunk from an approved worker tool.
 *
 * @param chunk - Unknown streamed graph chunk.
 * @returns Bounded tool lifecycle event or `null` for narration/unknown tools.
 */
export function parseWorkerToolEvent(chunk: unknown): OpenWikiRunEvent | null {
  if (
    !Array.isArray(chunk) ||
    chunk.length !== 3 ||
    chunk[1] !== "tools" ||
    !isRecord(chunk[2])
  ) {
    return null;
  }

  const payload = chunk[2];
  const name = typeof payload.name === "string" ? payload.name : "";
  if (!WORKER_TOOL_NAMES.has(name)) return null;

  const id = typeof payload.toolCallId === "string" ? payload.toolCallId : name;
  if (payload.event === "on_tool_start") {
    return {
      type: "tool_start",
      call: name,
      id,
      input: payload.input,
      name,
    };
  }

  if (payload.event === "on_tool_end" || payload.event === "on_tool_error") {
    return {
      type: "tool_end",
      id,
      name,
      status: payload.event === "on_tool_error" ? "error" : "finished",
    };
  }

  return null;
}

/**
 * Identifies the durable core's explicit whole-plan source-drift invalidation.
 *
 * @param error - Unknown finish failure.
 * @returns Whether the runner must rebuild runtime context and replan.
 */
function isSourceDriftInvalidation(error: unknown): boolean {
  return (
    error instanceof RepositoryRunError &&
    error.code === "conflict" &&
    error.message.startsWith(
      "Repository source changed during this OpenWiki run.",
    )
  );
}

/**
 * Narrows an unknown value to an object with string keys.
 *
 * @param value - Unknown candidate value.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
