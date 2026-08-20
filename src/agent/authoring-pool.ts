/**
 * Host-side authoring pool and repair-wave driver.
 *
 * The orchestration was the run's largest uncontrolled variable. Given the same
 * prompt, graded runs wrote materially different schedulers in REPL JavaScript:
 * one dispatched authors in fixed slices of eighteen and waited for the slowest
 * author in each slice, another pooled them; one called resolve_claims once per
 * page a hundred and eight times, another batched; one ran four verifier waves
 * against an unchanged wiki before repairing anything; and one indexed a text
 * block as an array and silently skipped its entire QA phase. Every instruction
 * added to correct these worked twice and failed once, because a prompt asks for
 * a scheduler and cannot guarantee one.
 *
 * So the scheduler stops being an instruction. This middleware exposes it as a
 * tool: the model supplies assignments and policy, and the pool, the refill, the
 * settling, the deduplication and the result parsing happen here, identically on
 * every run. What the model is good at - deciding which pages exist and what
 * evidence each author needs - stays with the model.
 *
 * It dispatches through the same `task` tool the agent already holds, found the
 * way @langchain/quickjs finds it: from `request.tools` in `wrapModelCall`.
 * Subagent selection, permissions and filesystem confinement are therefore
 * unchanged - this is a scheduling wrapper, not a second dispatch path.
 */

import { tool } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import type { ClaimSession } from "../claims/brains/code/session.js";
import { z } from "zod";
import {
  canonicalWikiPage,
  missingEvidence,
  renderBrief,
  type PlanStore,
} from "./plan-store.js";
import { dispatchSubagent, type TaskToolLike } from "./subagent-dispatch.js";

/**
 * Authors in flight at once.
 *
 * Twenty was the figure the prompt asked for and the figure a pooled run
 * actually sustained. The cap is on concurrent subagents rather than on batch
 * size, which is the whole difference: a slice of twenty finishes when its
 * slowest author does, while a pool of twenty is twenty busy authors until the
 * work runs out.
 */
const DEFAULT_AUTHOR_CONCURRENCY = 20;

/** Hard ceiling, so a model-supplied concurrency cannot become a fork bomb. */
const MAX_AUTHOR_CONCURRENCY = 32;

/**
 * Times author_pages refuses a plan that leaves part of the repository uncovered
 * before authoring it anyway.
 *
 * The bound exists so a plan the check never passes still produces a wiki. A
 * coordinator that acts on the message clears it in a call or two, so reaching
 * this many refusals means the remedy is not being applied.
 */
const MAX_BLOCKED_ATTEMPTS = 6;

/**
 * Runs `worker` over `items` as a refilling pool rather than as batches.
 *
 * Each slot takes the next unstarted item the moment it settles, so one slow
 * item delays only itself. Rejections are captured per item, never thrown: a
 * pool that aborts on the first failure would lose every author still running.
 *
 * @param items - Work items in dispatch order.
 * @param limit - Maximum items in flight.
 * @param worker - Per-item async operation.
 * @returns Settled outcomes in the order `items` were supplied.
 */
export async function pool<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  worker: (item: TItem, index: number) => Promise<TResult>,
): Promise<PromiseSettledResult<TResult>[]> {
  const outcomes: PromiseSettledResult<TResult>[] = Array.from(
    { length: items.length },
    () => ({ status: "rejected", reason: new Error("not started") }),
  );
  let next = 0;
  const slots = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) {
          return;
        }
        try {
          outcomes[index] = {
            status: "fulfilled",
            value: await worker(items[index], index),
          };
        } catch (reason) {
          outcomes[index] = { status: "rejected", reason };
        }
      }
    })(),
  );
  await Promise.all(slots);
  return outcomes;
}

/** One page's authoring outcome, as the REPL receives it. */
interface AuthorOutcome {
  page: string;
  claims: number;
  error?: string;
}

const AssignmentSchema = z.object({
  page: z.string().min(1),
  defect: z
    .string()
    .min(1)
    .optional()
    .describe("What to fix, when re-authoring an existing page."),
});

const AuthorPagesInputSchema = z.object({
  assignments: z.array(AssignmentSchema).min(1),
  concurrency: z.number().int().positive().optional(),
});

/**
 * Creates the authoring-pool middleware.
 *
 * @returns Middleware exposing `author_pages`, for registration in `ptc`.
 */
export function createOpenWikiAuthoringPoolMiddleware(
  store: PlanStore,
  readiness?: () => Promise<{ blocking: string[]; shortfall: string[] }>,
  session?: ClaimSession,
) {
  // Narrow to what dispatch needs, because the request's tool union includes
  // shapes without `invoke` and this only ever calls one tool by name.
  let taskTool: TaskToolLike | null = null;
  let blockedAttempts = 0;

  const authorPages = tool(
    async (rawInput, config) => {
      const input = AuthorPagesInputSchema.parse(rawInput);
      if (!taskTool) {
        throw new Error(
          "author_pages requires the subagent task tool, which is not registered on this agent.",
        );
      }
      const dispatch = taskTool;

      // One author per page, ever. Two authors on one page race on the write
      // and the loser's evidence is silently gone, so a repeated page is a
      // caller bug worth reporting rather than a request worth honouring.
      const seen = new Set<string>();
      const assignments: { page: string; defect?: string }[] = [];
      const duplicates: string[] = [];
      for (const assignment of input.assignments) {
        // Canonical, so `a/b`, `a/b.md`, and `/openwiki/a/b.md` are one page
        // rather than three authors racing on one file.
        const key = canonicalWikiPage(assignment.page);
        if (seen.has(key)) {
          duplicates.push(assignment.page);
          continue;
        }
        seen.add(key);
        assignments.push({ ...assignment, page: key });
      }

      const limit = Math.min(
        input.concurrency ?? DEFAULT_AUTHOR_CONCURRENCY,
        MAX_AUTHOR_CONCURRENCY,
      );

      // The brief is rendered from the plan, not supplied by the caller. A
      // free-form brief said "inspect the relevant source directory implied by
      // this page path" and listed every page in the wiki as a link target,
      // which is how the critic's evidence got discarded between planning and
      // authoring.
      const ledger = store.get();
      if (!ledger) {
        throw new Error(
          "author_pages requires a recorded plan: call submit_plan first.",
        );
      }
      // submit_plan accumulates and no longer rejects an incomplete plan, so
      // completeness is required here instead: authoring from a plan that
      // defers most of the repository produces a wiki covering none of it.
      const state = readiness
        ? await readiness()
        : { blocking: [], shortfall: [] };
      // A directory no entry covers still stops authoring, bounded: that subtree
      // is absent from the result and no later step can tell. Under-decomposition
      // does not, because refusing over it is what once left a run with a
      // complete plan and one page on disk - it travels back with the pages that
      // were written, and finalize_wiki is where it has to be answered, by which
      // point holding the run costs a turn rather than the wiki.
      if (state.blocking.length > 0) {
        blockedAttempts += 1;
        if (blockedAttempts <= MAX_BLOCKED_ATTEMPTS) {
          return JSON.stringify({
            authored: 0,
            blocked: state.blocking,
            attemptsLeft: MAX_BLOCKED_ATTEMPTS - blockedAttempts + 1,
            hint: "Fix these through submit_plan, then call author_pages again. Entries accumulate, so send only what changes. submit_plan is one of your own tools - it is not a global inside the code interpreter, so do not conclude from the interpreter's namespace that there is no way to repair the plan.",
          });
        }
      }
      const shortfall =
        state.shortfall.length > 0 ? state.shortfall : undefined;
      const dispatchable: { page: string; brief: string }[] = [];
      const undispatchable: { page: string; error: string }[] = [];
      for (const assignment of assignments) {
        const key = assignment.page;
        const planned = ledger.pages.get(key);
        if (!planned) {
          undispatchable.push({
            page: key,
            error:
              "Not in the plan. Add it through submit_plan with its evidence, or drop it.",
          });
          continue;
        }
        const missing = missingEvidence(planned);
        if (missing.length > 0) {
          undispatchable.push({
            page: key,
            error: `Plan entry is missing ${missing.join(", ")}; an author sent without them writes only what it can see.`,
          });
          continue;
        }
        dispatchable.push({
          page: assignment.page,
          brief: renderBrief(planned, assignment.defect),
        });
      }

      const outcomes = await pool(dispatchable, limit, async (assignment) => {
        const output = await dispatchSubagent(
          dispatch,
          "page-author",
          assignment.brief,
          config,
        );
        return { assignment, output };
      });

      // Counts come from the claim session, which is the authority on what was
      // established. Asking the author to report them put the same payload
      // through the same seam under a different name, and a report can disagree
      // with the store while the store cannot disagree with itself.
      const results: AuthorOutcome[] = outcomes.map((outcome, index) => {
        const page = dispatchable[index].page;
        if (outcome.status === "rejected") {
          return {
            page,
            claims: 0,
            error:
              outcome.reason instanceof Error
                ? outcome.reason.message
                : String(outcome.reason),
          };
        }
        // inspectClaims throws on a path it will not accept, and this runs
        // inside a map over model-supplied strings: one bad path took down a
        // whole author_pages call, and with it a run's entire authoring phase.
        // A count that cannot be read is a count of zero, which the caller
        // already knows how to treat.
        let claims: number;
        try {
          claims = session ? session.inspectClaims(page).length : 0;
        } catch {
          claims = 0;
        }
        return { page, claims };
      });

      // Zero claims is a failed task, not a page needing another pass. A page
      // is written only alongside its claims now, so an author that established
      // none produced nothing - and re-dispatching the same brief that already
      // produced nothing is how a run spent 136 author calls on 68 pages.
      for (const result of results) {
        if (!result.error && result.claims === 0) {
          result.error =
            "Author established no claims, so it wrote nothing. Do not re-dispatch this brief unchanged: give it the specific evidence anchors it lacked, or drop the page.";
        }
      }
      const failed = [...undispatchable, ...results.filter((r) => r.error)];

      return JSON.stringify({
        authored: results.length - failed.length,
        claimsEstablished: results.reduce(
          (total, result) => total + result.claims,
          0,
        ),
        failed,
        ...(duplicates.length > 0 ? { duplicatePagesIgnored: duplicates } : {}),
        ...(shortfall
          ? {
              planShortfall: shortfall,
              hint: "These pages were written. The plan is still short of what the repository holds, and finalize_wiki will not pass until it is not: add the pages through submit_plan and author them.",
            }
          : {}),
      });
    },
    {
      name: "author_pages",
      description:
        "Dispatch one page-author per assignment as a refilling pool of twenty and return each page's outcome. Pass the whole phase - initial authoring or one repair wave - in a single call: it pools, refills as each author settles, dedupes repeated pages, and reports a failed author against its own page rather than losing the pool. Each author writes its page and establishes its own Claims, so you do not call resolve_claims for these pages; the counts come back from the claim store itself. An author that establishes no claims is returned under failed and wrote nothing. Each assignment is just {page}, plus {defect} when re-authoring: the brief is rendered from that page's plan entry, so its evidence, tests, and relationship edges reach the author without you composing anything, and only the pages it has an edge to are named as link targets. A page absent from the plan, or missing an anchor, entrypoint, or focused test, comes back under failed rather than being dispatched with a gap. Never call this once per page and never run two calls covering the same page at once.",
      schema: AuthorPagesInputSchema,
    },
  );

  return createMiddleware({
    name: "OpenWikiAuthoringPoolMiddleware",
    tools: [authorPages],
    wrapModelCall: (request, handler) => {
      // Same source @langchain/quickjs reads it from: the task tool is created
      // by the subagent middleware and only appears on the request.
      const found = (request.tools ?? []).find(
        (candidate: { name?: string }) => candidate.name === "task",
      );
      taskTool ??= (found as unknown as typeof taskTool) ?? null;
      return handler(request);
    },
  });
}
