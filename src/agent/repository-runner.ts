import { scheduler } from "node:timers/promises";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  ChatMessage,
  ChatMessageChunk,
  ToolMessage,
  collapseToolCallChunks,
  defaultToolCallParser,
  type InvalidToolCall,
  type ToolCall,
  type ToolCallChunk,
} from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { RepositoryRunError } from "../generation/errors.js";
import {
  beginRepositoryRun,
  captureRepositoryPageSnapshot,
  finishRepositoryRun,
  inspectRepositoryPageClaims,
  nextRepositoryPage,
  skipRepositoryPage,
  submitRepositoryPage,
  submitRepositoryPlan,
  type ActiveBeginView,
  type ActiveRepositoryRun,
  type BeginRepositoryRunResult,
  type NextRepositoryPageResult,
  type RepositoryPageSnapshot,
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

const ClaimReconciliationSchema = z
  .object({
    confirmedClaimIds: z.array(z.string().trim().min(1)).optional(),
    claims: z.array(ClaimSchema).optional(),
    retractedClaimIds: z.array(z.string().trim().min(1)).optional(),
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
  "inspect_claims",
  "submit_page",
]);

// DeepAgents 1.12 adds a general-purpose task tool even when subagents is
// empty. Repository workers are deliberately non-delegating, so remove that
// model-facing capability after all tool-contributing middleware has run.
const NO_DELEGATION_MIDDLEWARE = createMiddleware({
  name: "OpenWikiRepositoryWorkerNoDelegation",
  wrapModelCall: async (request, handler) => {
    const response = await handler({
      ...request,
      tools: request.tools?.filter(({ name }) => name !== "task"),
    });

    return coerceRepositoryWorkerModelResponse(response);
  },
});

type PendingPageJob = Extract<
  NextRepositoryPageResult,
  { status: "pending" }
>["job"];

/**
 * Normalizes provider-streaming aggregates that are assistant output but were
 * typed as generic chat messages because the first OpenAI-compatible SSE delta
 * arrived without `role:"assistant"` (for example reasoning-only first deltas).
 *
 * LangChain validates each wrapModelCall response before the agent node can
 * continue. Coerce only this repository-worker boundary so provider transport
 * handling stays owned by the model client.
 */
function coerceRepositoryWorkerModelResponse(response: AIMessage): AIMessage {
  const candidate: unknown = response;

  if (AIMessage.isInstance(candidate)) {
    return candidate;
  }

  if (
    ChatMessageChunk.isInstance(candidate) &&
    isGenericAssistantModelResponse(candidate)
  ) {
    const rawToolCalls = getOpenAiRawToolCalls(candidate.additional_kwargs);
    const toolCallFields =
      rawToolCalls === null
        ? {}
        : collapseToolCallChunks(rawToolCalls.map(toToolCallChunk));

    return new AIMessageChunk({
      content: candidate.content,
      additional_kwargs: candidate.additional_kwargs,
      response_metadata: candidate.response_metadata,
      id: candidate.id,
      name: candidate.name,
      ...toolCallFields,
    });
  }

  if (
    ChatMessage.isInstance(candidate) &&
    isGenericAssistantModelResponse(candidate)
  ) {
    const rawToolCalls = getOpenAiRawToolCalls(candidate.additional_kwargs);
    const toolCallFields =
      rawToolCalls === null ? {} : parseRawOpenAiToolCalls(rawToolCalls);

    return new AIMessage({
      content: candidate.content,
      additional_kwargs: candidate.additional_kwargs,
      response_metadata: candidate.response_metadata,
      id: candidate.id,
      name: candidate.name,
      ...toolCallFields,
    });
  }

  return response;
}

function isGenericAssistantModelResponse(response: { role?: string }): boolean {
  return response.role === undefined || response.role === "assistant";
}

function getOpenAiRawToolCalls(
  additionalKwargs: Record<string, unknown> | undefined,
): Record<string, unknown>[] | null {
  const rawToolCalls = additionalKwargs?.tool_calls;

  if (!Array.isArray(rawToolCalls)) {
    return null;
  }

  return rawToolCalls.filter(isRecord);
}

function parseRawOpenAiToolCalls(rawToolCalls: Record<string, unknown>[]): {
  invalid_tool_calls: InvalidToolCall[];
  tool_calls: ToolCall[];
} {
  const [toolCalls, invalidToolCalls] = defaultToolCallParser(rawToolCalls);

  return {
    invalid_tool_calls: invalidToolCalls,
    tool_calls: toolCalls,
  };
}

function toToolCallChunk(rawToolCall: Record<string, unknown>): ToolCallChunk {
  const rawFunction = rawToolCall.function;
  const functionFields = isRecord(rawFunction) ? rawFunction : {};

  return {
    id: typeof rawToolCall.id === "string" ? rawToolCall.id : undefined,
    index:
      typeof rawToolCall.index === "number" ? rawToolCall.index : undefined,
    name:
      typeof functionFields.name === "string" ? functionFields.name : undefined,
    args:
      typeof functionFields.arguments === "string"
        ? functionFields.arguments
        : undefined,
    type: "tool_call_chunk",
  };
}

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
   * Actual user and connector context supplied to planning.
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
   * Maximum page workers running at once.
   *
   * Each worker still owns exactly one page. With more than one worker the
   * quickstart page is held back until every other page has finished, so its
   * task-routing map links to pages that exist. A worker that fails on a
   * provider rate limit lowers the live limit by one, never below 1.
   *
   * @default 1
   */
  pageConcurrency?: number;

  /**
   * Delay between the first wave of worker starts, per slot, in milliseconds.
   *
   * Spreads the opening model requests of concurrent workers so they do not
   * hit the provider at the same instant. Ignored for a single worker.
   *
   * @default 1000
   */
  workerStartStaggerMs?: number;

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

  /**
   * Whether the repository changed after planning, leaving a later update due.
   */
  sourceChanged?: true;
}

/**
 * Drives the shared lifecycle with one planner and one fresh agent per page.
 *
 * The supplied model is reused, but no repository-generation checkpointer or
 * worker state survives beyond the durable core.
 *
 * @param options - Repository, model, planning context, and event consumer.
 * @returns No-op status and whether a later update remains due to source drift.
 */
export async function runNativeRepositoryGeneration(
  options: NativeRepositoryGenerationOptions,
): Promise<NativeRepositoryGenerationResult> {
  const begun = await beginNativeRepositoryRun(options);
  if (!("run" in begun)) {
    options.onEvent?.({ type: "repository_progress", stage: "noop" });
    return { skipped: true };
  }

  const { run, view } = begun;
  if (run.state.phase === "planning") {
    options.onEvent?.({
      type: "repository_progress",
      stage: "planning",
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

  const skippedPageSnapshots = await runPendingPageAgents(
    run,
    options.model,
    options.onEvent,
    view,
    options.pageConcurrency ?? 1,
    options.workerStartStaggerMs ?? DEFAULT_WORKER_START_STAGGER_MS,
  );
  options.onEvent?.({
    type: "repository_progress",
    stage: "finalizing",
    resumed: view.resumed,
    pageCount: run.state.plan?.pages.length,
  });

  const result = await finishRepositoryRun(run, { skippedPageSnapshots });
  if (result.sourceChanged) {
    options.onEvent?.({
      type: "text",
      source: "main",
      text: "Repository source changed while OpenWiki was running. The wiki was finalized without advancing its source checkpoint; run openwiki --update to reconcile the changes.\n",
    });
  }
  return result.sourceChanged
    ? { skipped: false, sourceChanged: true }
    : { skipped: false };
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
 * Runs one bounded planner that must submit a durable plan.
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

const QUICKSTART_PAGE_PATH = "/openwiki/quickstart.md";
const DEFAULT_WORKER_START_STAGGER_MS = 1_000;

/**
 * Result of one bounded page worker.
 */
type PageAgentOutcome =
  | { status: "submitted" }
  | { status: "skipped"; snapshot: RepositoryPageSnapshot; error?: unknown };

/**
 * Process-local bookkeeping shared by the worker loops of one run.
 *
 * Nothing here is durable: the checkpoint only records pending, skipped, and
 * complete jobs, and a resumed run rebuilds ownership from scratch.
 */
interface PageWorkerPool {
  /**
   * Whether the run was configured with more than one worker.
   */
  concurrent: boolean;

  /**
   * Job ids handed to a worker in this process; never offered again.
   */
  claimed: Set<string>;

  /**
   * Serializes job acquisition so two loops never select the same job.
   *
   * `nextRepositoryPage` selects before its first await, so concurrent calls
   * in one tick would all see the same unclaimed head of the queue.
   */
  acquiring: Promise<void>;

  /**
   * Canonical pages currently being written, in start order.
   */
  inFlight: string[];

  /**
   * Live worker limit; lowered after rate-limit failures, never below 1.
   */
  size: number;

  /**
   * First fatal error; once set, loops stop taking new jobs.
   */
  fatal: { error: unknown } | null;

  /**
   * Snapshots of pages whose worker exited without submitting.
   */
  skipped: RepositoryPageSnapshot[];
}

/**
 * Runs every remaining page job with fresh bounded workers, up to
 * `pageConcurrency` at a time.
 *
 * Every page except quickstart is documented first. With one worker the
 * queue order already places quickstart last; with several, it is held back
 * explicitly so its task-routing map links to pages that already exist. A
 * fatal submission error stops new work, lets in-flight workers submit or
 * skip, and is rethrown before finish so the run never finalizes with
 * pending jobs.
 *
 * @param run - Active run containing the persisted queue.
 * @param model - Initialized model reused across fresh workers.
 * @param onEvent - Optional lifecycle and tool-event consumer.
 * @param view - Begin view used to retain resume state in progress events.
 * @param pageConcurrency - Maximum workers running at once.
 * @param workerStartStaggerMs - Per-slot delay for the first wave of starts.
 * @returns Snapshots of every page skipped during this pass.
 */
async function runPendingPageAgents(
  run: ActiveRepositoryRun,
  model: BaseChatModel,
  onEvent: ((event: OpenWikiRunEvent) => void) | undefined,
  view: ActiveBeginView,
  pageConcurrency: number,
  workerStartStaggerMs: number,
): Promise<RepositoryPageSnapshot[]> {
  const size = Math.max(1, Math.floor(pageConcurrency));
  const pool: PageWorkerPool = {
    concurrent: size > 1,
    claimed: new Set(),
    acquiring: Promise.resolve(),
    inFlight: [],
    size,
    fatal: null,
    skipped: [],
  };
  const pages = run.state.plan?.pages ?? [];
  const heldBack = new Set(
    pool.concurrent
      ? pages
          .filter(({ path }) => path === QUICKSTART_PAGE_PATH)
          .map(({ id }) => id)
      : [],
  );

  await runWorkerLoops(
    run,
    model,
    onEvent,
    view,
    pool,
    heldBack,
    workerStartStaggerMs,
  );
  if (!pool.fatal && heldBack.size > 0) {
    pool.size = 1;
    await runWorkerLoops(run, model, onEvent, view, pool, new Set(), 0);
  }

  if (pool.fatal) throw pool.fatal.error;
  return pool.skipped;
}

/**
 * Runs `pool.size` worker loops to completion over the jobs not held back.
 */
async function runWorkerLoops(
  run: ActiveRepositoryRun,
  model: BaseChatModel,
  onEvent: ((event: OpenWikiRunEvent) => void) | undefined,
  view: ActiveBeginView,
  pool: PageWorkerPool,
  heldBack: ReadonlySet<string>,
  workerStartStaggerMs: number,
): Promise<void> {
  await Promise.all(
    Array.from({ length: pool.size }, (_, slot) =>
      runWorkerLoop(
        slot,
        run,
        model,
        onEvent,
        view,
        pool,
        heldBack,
        workerStartStaggerMs,
      ),
    ),
  );
}

/**
 * One worker slot: claims the next unowned pending job, documents it with a
 * fresh agent, and repeats until the queue is drained, a fatal error is
 * recorded, or the live pool size no longer includes this slot.
 */
async function runWorkerLoop(
  slot: number,
  run: ActiveRepositoryRun,
  model: BaseChatModel,
  onEvent: ((event: OpenWikiRunEvent) => void) | undefined,
  view: ActiveBeginView,
  pool: PageWorkerPool,
  heldBack: ReadonlySet<string>,
  workerStartStaggerMs: number,
): Promise<void> {
  if (slot > 0 && workerStartStaggerMs > 0) {
    await scheduler.wait(slot * workerStartStaggerMs);
  }

  while (!pool.fatal && slot < pool.size) {
    const next = await acquireNextJob(run, pool, heldBack);
    // Another worker can fail fatally while this loop waits for serialized job
    // acquisition. Do not start model work for that newly claimed page.
    if (pool.fatal || slot >= pool.size) return;
    if (next.status === "complete") return;

    pool.inFlight.push(next.job.path);
    emitGeneratingProgress(run, view, pool, next.job.path, onEvent);

    let outcome: PageAgentOutcome;
    try {
      outcome = await runPageAgent(run, next.job, model, onEvent);
    } catch (error) {
      pool.fatal ??= { error };
      removeInFlightPage(pool, next.job.path);
      return;
    }
    removeInFlightPage(pool, next.job.path);

    if (outcome.status === "skipped") {
      pool.skipped.push(outcome.snapshot);
      if (pool.size > 1 && isRateLimitError(outcome.error)) {
        pool.size -= 1;
        onEvent?.({
          type: "text",
          source: "main",
          text: `Reduced page concurrency to ${pool.size} after a provider rate limit while documenting ${next.job.path}.\n`,
        });
      }
    }

    if (pool.concurrent && pool.inFlight.length > 0) {
      emitGeneratingProgress(run, view, pool, pool.inFlight.at(-1), onEvent);
    }
  }
}

/**
 * Selects and claims the next unowned pending job, one loop at a time.
 *
 * @param run - Active run containing the persisted queue.
 * @param pool - Shared worker bookkeeping holding the claim set.
 * @param heldBack - Job ids deferred to a later pass.
 * @returns The claimed job with its worker context, or queue completion.
 */
function acquireNextJob(
  run: ActiveRepositoryRun,
  pool: PageWorkerPool,
  heldBack: ReadonlySet<string>,
): Promise<NextRepositoryPageResult> {
  const acquisition = pool.acquiring.then(async () => {
    const next = await nextRepositoryPage(run, {
      exclude: new Set([...pool.claimed, ...heldBack]),
    });
    if (next.status === "pending") pool.claimed.add(next.job.id);
    return next;
  });
  pool.acquiring = acquisition.then(
    () => undefined,
    () => undefined,
  );
  return acquisition;
}

function removeInFlightPage(pool: PageWorkerPool, page: string): void {
  const index = pool.inFlight.indexOf(page);
  if (index >= 0) pool.inFlight.splice(index, 1);
}

/**
 * Emits generating-stage progress for the focused page.
 *
 * A single worker emits exactly the historical shape. A concurrent pool adds
 * the completed count and the in-flight page list so consumers can render the
 * run without pretending one queue position describes it.
 */
function emitGeneratingProgress(
  run: ActiveRepositoryRun,
  view: ActiveBeginView,
  pool: PageWorkerPool,
  focusPage: string | undefined,
  onEvent: ((event: OpenWikiRunEvent) => void) | undefined,
): void {
  const pages = run.state.plan?.pages ?? [];
  const pageIndex = pages.findIndex(({ path }) => path === focusPage) + 1;
  onEvent?.({
    type: "repository_progress",
    stage: "generating",
    resumed: view.resumed,
    page: focusPage,
    pageIndex,
    pageCount: pages.length,
    ...(pool.concurrent
      ? {
          completedCount: pages.filter(({ status }) => status !== "pending")
            .length,
          inFlightPages: [...pool.inFlight],
        }
      : {}),
  });
}

/**
 * Recognizes provider rate limiting in an error raised by a page worker.
 *
 * Checks HTTP 429 status fields, common provider error codes, and message
 * text, following `cause` chains so wrapped SDK errors are recognized too.
 *
 * @param error - Unknown error thrown by a worker's agent stream.
 * @returns Whether the failure was a rate limit rather than a page problem.
 */
export function isRateLimitError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let candidate: unknown = error;
  while (isRecord(candidate) && !seen.has(candidate)) {
    seen.add(candidate);
    const status = candidate.status ?? candidate.statusCode;
    if (status === 429 || candidate.code === 429) return true;
    if (
      typeof candidate.code === "string" &&
      /rate.?limit/iu.test(candidate.code)
    ) {
      return true;
    }
    if (
      typeof candidate.message === "string" &&
      /\b429\b|rate.?limit|too many requests/iu.test(candidate.message)
    ) {
      return true;
    }
    candidate = candidate.cause;
  }
  return false;
}

/**
 * Runs one shell-free worker bounded to its assigned page and Claim submission.
 *
 * @param run - Active durable repository run.
 * @param job - Pending page job owned by this worker.
 * @param model - Initialized model used only for this worker.
 * @param onEvent - Optional bounded worker event consumer.
 * @returns Whether the page was submitted, or the snapshot restored on skip.
 */
async function runPageAgent(
  run: ActiveRepositoryRun,
  job: PendingPageJob,
  model: BaseChatModel,
  onEvent?: (event: OpenWikiRunEvent) => void,
): Promise<PageAgentOutcome> {
  const snapshot = await captureRepositoryPageSnapshot(run, job.id);
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
  let fatalSubmissionFailure = false;
  const inspectClaimsTool = new DynamicStructuredTool({
    name: "inspect_claims",
    description:
      "Return this page's complete current Claim set without opaque evidence versions. Use only before intentionally revising or removing otherwise-current content; stale or unresolved Claims already appear in the assignment.",
    schema: z.object({}).strict(),
    func: () =>
      Promise.resolve(JSON.stringify(inspectRepositoryPageClaims(run, job.id))),
  });
  const submitPageTool = new DynamicStructuredTool({
    name: "submit_page",
    description:
      "Complete the assigned page after writing it. Submit only sparse Claim decisions: confirmedClaimIds for rechecked issue Claims kept unchanged, claims for revisions/additions, and retractedClaimIds for removals. Other current Claims are retained automatically. Evidence must use repo://<repository-relative-path>, optionally with #Lx-Ly.",
    schema: ClaimReconciliationSchema,
    func: async (reconciliation, _runManager, config) => {
      if (submitted) {
        throw new Error("submit_page was already called for this page worker.");
      }
      try {
        const result = await submitRepositoryPage(run, {
          jobId: job.id,
          ...reconciliation,
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
            "Correct the assigned page or sparse Claim decisions and call submit_page again.",
            (config as { toolCall?: { id?: string } } | undefined)?.toolCall
              ?.id,
          );
        }
        fatalSubmissionFailure = true;
        throw error;
      }
    },
  });

  const backend = createAgentBackend(wikiBackend);
  const agent = createDeepAgent({
    model,
    tools: [inspectClaimsTool, submitPageTool],
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

  try {
    await streamWorkerTools(
      agent,
      [
        {
          role: "user",
          content: "Research and document the assigned page, then submit it.",
        },
      ],
      onEvent,
      job.path,
    );
  } catch (error) {
    if (submitted) return { status: "submitted" };
    if (fatalSubmissionFailure) throw error;
    await skipRepositoryPage(run, snapshot);
    emitDeferredPageWarning(job.path, onEvent);
    return { status: "skipped", snapshot, error };
  }

  if (submitted) return { status: "submitted" };

  await skipRepositoryPage(run, snapshot);
  emitDeferredPageWarning(job.path, onEvent);
  return { status: "skipped", snapshot };
}

function emitDeferredPageWarning(
  page: string,
  onEvent?: (event: OpenWikiRunEvent) => void,
): void {
  onEvent?.({
    type: "text",
    source: "main",
    text: `${page} was restored after its worker exited without submitting. It was skipped for this update and will be reconsidered on the next update.\n`,
  });
}

/**
 * Streams only bounded worker tool lifecycle events, never worker narration.
 *
 * @param agent - Fresh planner or page agent.
 * @param messages - Single worker instruction message.
 * @param onEvent - Optional CLI event consumer.
 * @param page - Canonical page owned by a page worker, tagged onto its events.
 */
async function streamWorkerTools(
  agent: ReturnType<typeof createDeepAgent>,
  messages: Array<{ role: "user"; content: string }>,
  onEvent?: (event: OpenWikiRunEvent) => void,
  page?: string,
): Promise<void> {
  const stream = await agent.stream(
    { messages },
    { streamMode: ["tools"], subgraphs: true },
  );

  for await (const chunk of stream) {
    const event = parseWorkerToolEvent(chunk);
    if (!event) continue;
    onEvent?.(
      page !== undefined &&
        (event.type === "tool_start" || event.type === "tool_end")
        ? { ...event, page }
        : event,
    );
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
 * Narrows an unknown value to an object with string keys.
 *
 * @param value - Unknown candidate value.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
