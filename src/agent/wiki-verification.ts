/**
 * Host-owned semantic QA.
 *
 * The wave structure, the parsing and the budget live here rather than in a
 * prompt, so that QA either runs as this program or does not run at all - an
 * agent cannot skip it and report success, and cannot improvise a different
 * number of waves. `off` and `full` therefore differ in exactly one thing.
 *
 * `off` is a supported mode that finalizes without QA; running it is a
 * configuration choice, not something this module mandates.
 *
 * The budget is one initial wave over every question, then one wave over only
 * what stayed unresolved. Questions are generated once and never regenerated:
 * re-deriving them on a retry silently changes the test between waves, so IDs
 * and acceptance criteria are held here and reused.
 *
 * An infrastructure failure - a question-finder that returns prose, a verifier
 * that answers about questions it was not sent - is recorded as
 * `infrastructure_error` and does NOT block finalization. A run that authored
 * sixty pages has done real work, and discarding it because the QA plumbing
 * failed would burn every token that produced those pages to learn nothing.
 * Recording it distinctly is what keeps such a run out of a QA comparison
 * without also throwing away the wiki.
 */

import { tool } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { dispatchSubagent, type TaskToolLike } from "./subagent-dispatch.js";

/** How a run's semantic QA ended. Distinct so zero QA cannot read as success. */
export type QaStatus =
  "not_triggered" | "passed" | "failed" | "infrastructure_error";

/** Shared between the verifier and the completion gate. */
export interface QaGate {
  mode: "off" | "full";
  status: QaStatus;
  wavesRun: number;
  unresolved: string[];
}

/** Questions per verifier dispatch: related enough to share pages, small enough to stay accurate. */
const QUESTIONS_PER_BATCH = 3;

/** Initial wave plus one unresolved-only wave. */
const MAX_WAVES = 2;

/**
 * Reports why QA should block finishing, or null when it should not.
 *
 * Policy lives here rather than in the completion gate because it depends on
 * the wave budget. If the two disagree the run deadlocks: with the budget spent
 * and questions still unresolved, a gate that blocks on `failed` can never be
 * satisfied. The gate exists to stop QA being SKIPPED, not to demand that every
 * question passes.
 *
 * So `failed` blocks only while a wave remains to fix it. Once the budget is
 * spent, unresolved questions are a recorded outcome. `infrastructure_error`
 * never blocks at all.
 *
 * @param gate - Run-scoped QA state.
 * @returns Problem text for the finalization report, or null.
 */
export function qaFinalizationProblem(gate: QaGate): string | null {
  if (gate.mode !== "full") {
    return null;
  }
  if (gate.status === "not_triggered") {
    return "Semantic QA has not run. Call verify_wiki, repair what it reports, then verify again.";
  }
  if (gate.status === "failed" && gate.wavesRun < MAX_WAVES) {
    return `Semantic QA left ${gate.unresolved.length} question(s) unresolved: ${gate.unresolved.slice(0, 10).join(", ")}. Repair the reported pages through author_pages, then call verify_wiki again.`;
  }
  return null;
}

/**
 * Creates the QA gate a run shares between `verify_wiki` and `finalize_wiki`.
 *
 * @param mode - Whether semantic QA runs at all.
 * @returns Fresh gate in its pre-QA state.
 */
export function createQaGate(mode: "off" | "full"): QaGate {
  return { mode, status: "not_triggered", wavesRun: 0, unresolved: [] };
}

/** One question, as parsed once and then reused across waves. */
interface Question {
  id: string;
  text: string;
}

/**
 * Parses the question-finder's text block into stable questions.
 *
 * @param output - Raw subagent output.
 * @returns Questions in the order returned, empty when nothing parsed.
 */
export function parseQuestions(output: string): Question[] {
  const seen = new Set<string>();
  const questions: Question[] = [];
  for (const match of output.matchAll(
    /\[(Q-\d+)\]:([\s\S]*?)(?=\n\s*\[Q-\d+\]:|$)/gu,
  )) {
    const id = match[1];
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    questions.push({ id, text: `[${id}]:${match[2].trimEnd()}` });
  }
  return questions;
}

/**
 * Parses one verifier batch into per-question verdicts.
 *
 * @param output - Raw subagent output.
 * @returns Verdicts keyed by question ID.
 */
export function parseVerdicts(
  output: string,
): { id: string; status: string; missing: string }[] {
  return [
    ...output.matchAll(
      /<result\s+id="([^"]+)"\s+status="(PASS|PARTIAL|FAIL)"\s*>([\s\S]*?)<\/result>/gu,
    ),
  ].map((match) => ({
    id: match[1],
    status: match[2],
    missing: (/<missing>([\s\S]*?)<\/missing>/u.exec(match[3]) ?? [])[1] ?? "",
  }));
}

/**
 * Creates the verification middleware.
 *
 * @param gate - Run-scoped QA state, shared with the completion gate.
 * @returns Middleware exposing `verify_wiki`.
 */
export function createOpenWikiVerificationMiddleware(gate: QaGate) {
  let taskTool: TaskToolLike | null = null;
  let questions: Question[] | null = null;

  const dispatch = async (
    subagentType: string,
    description: string,
    config: unknown,
  ): Promise<string> => {
    if (!taskTool) {
      throw new Error("verify_wiki requires the subagent task tool.");
    }
    return dispatchSubagent(taskTool, subagentType, description, config);
  };

  const verifyWiki = tool(
    async (_input, config) => {
      if (gate.mode === "off") {
        return JSON.stringify({
          status: "not_triggered",
          note: "Semantic QA is disabled for this run.",
        });
      }
      if (gate.wavesRun >= MAX_WAVES) {
        return JSON.stringify({
          status: gate.status,
          note: `The wave budget is ${MAX_WAVES}: one over every question, one over what stayed unresolved. Both are spent.`,
          unresolved: gate.unresolved,
        });
      }

      // Generated once. Re-deriving them on a retry would change the test
      // between waves, so a later PASS would not mean the defect was repaired.
      if (!questions) {
        // The verifier batches run under allSettled, so a failing one costs its
        // questions. This dispatch had no such containment: anything it threw -
        // a provider rejecting the prompt, a transport error - left verify_wiki
        // and ended the run, discarding a finished wiki over a call that says
        // nothing about it. QA failing is a recorded outcome, never the run's.
        let raw: string;
        try {
          raw = await dispatch(
            "wiki-question-finder",
            "Generate source-grounded questions for evaluating this wiki, in your documented [Q-NN] format.",
            config,
          );
        } catch (error) {
          gate.status = "infrastructure_error";
          questions = null;
          return JSON.stringify({
            status: "infrastructure_error",
            problem: `The question-finder dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
            note: "Semantic QA cannot run. This is recorded as an infrastructure failure, not a documentation defect, and it does not block finishing.",
          });
        }
        questions = parseQuestions(raw);
        if (questions.length === 0) {
          gate.status = "infrastructure_error";
          questions = null;
          return JSON.stringify({
            status: "infrastructure_error",
            problem:
              "The question-finder returned nothing parseable as [Q-NN] entries. Semantic QA cannot run; this does not block finishing, and is recorded as an infrastructure failure rather than a documentation defect.",
          });
        }
        gate.unresolved = questions.map((question) => question.id);
      }

      const pending = questions.filter((question) =>
        gate.unresolved.includes(question.id),
      );
      const batches: Question[][] = [];
      for (
        let index = 0;
        index < pending.length;
        index += QUESTIONS_PER_BATCH
      ) {
        batches.push(pending.slice(index, index + QUESTIONS_PER_BATCH));
      }

      const settled = await Promise.allSettled(
        batches.map((batch) =>
          dispatch(
            "wiki-answer-verifier",
            `Verify these questions using only /openwiki. Return your documented <results> block with exactly one <result> per question.\n\n${batch
              .map((question) => question.text)
              .join("\n\n")}`,
            config,
          ),
        ),
      );

      const verdicts = new Map<string, { status: string; missing: string }>();
      const dispatchFailures: string[] = [];
      for (const [index, outcome] of settled.entries()) {
        if (outcome.status === "rejected") {
          dispatchFailures.push(
            batches[index].map((question) => question.id).join(", "),
          );
          continue;
        }
        for (const verdict of parseVerdicts(outcome.value)) {
          verdicts.set(verdict.id, verdict);
        }
      }

      // Exactly one verdict per question sent, and none for a question that was
      // not. Either direction means the verdicts do not describe the wiki that
      // was verified, so it fails loudly rather than reading as partial success.
      const missingVerdicts = pending
        .filter((question) => !verdicts.has(question.id))
        .map((question) => question.id);
      const extraVerdicts = [...verdicts.keys()].filter(
        (id) => !pending.some((question) => question.id === id),
      );
      if (
        dispatchFailures.length === batches.length ||
        extraVerdicts.length > 0
      ) {
        gate.status = "infrastructure_error";
        return JSON.stringify({
          status: "infrastructure_error",
          problem:
            extraVerdicts.length > 0
              ? `Verifier returned verdicts for questions it was not sent: ${extraVerdicts.join(", ")}`
              : "Every verifier dispatch failed.",
          note: "Recorded as an infrastructure failure, not a documentation defect. It does not block finishing.",
        });
      }

      gate.wavesRun += 1;
      const unresolved = [
        ...missingVerdicts,
        ...pending
          .filter((question) => verdicts.get(question.id)?.status !== "PASS")
          .map((question) => question.id),
      ];
      gate.unresolved = [...new Set(unresolved)];
      gate.status = gate.unresolved.length === 0 ? "passed" : "failed";

      // Defects group by the page named in <missing>. One that names no page is
      // kept under a bucket rather than dropped: an unmappable defect is still a
      // defect, and silently discarding it is how a wave reports false success.
      const defectsByPage = new Map<string, string[]>();
      for (const question of pending) {
        const verdict = verdicts.get(question.id);
        if (!verdict || verdict.status === "PASS") {
          continue;
        }
        const page =
          (/(\/openwiki\/[\w./-]+\.md)/u.exec(verdict.missing) ?? [])[1] ??
          "unattributed";
        defectsByPage.set(page, [
          ...(defectsByPage.get(page) ?? []),
          `${question.id}: ${verdict.missing.trim()}`,
        ]);
      }

      return JSON.stringify({
        status: gate.status,
        wave: gate.wavesRun,
        wavesRemaining: MAX_WAVES - gate.wavesRun,
        verified: pending.length,
        unresolved: gate.unresolved,
        ...(dispatchFailures.length > 0
          ? { batchesThatFailedToDispatch: dispatchFailures }
          : {}),
        defectsByPage: Object.fromEntries(defectsByPage),
      });
    },
    {
      name: "verify_wiki",
      description:
        "Run one semantic QA wave over the wiki and return defects grouped by canonical page. It generates the question set on the first call and reuses it afterwards, dispatches every verifier batch concurrently, and returns one verdict per question. Call it once after the wiki is written, repair the returned defects through author_pages, then call it once more to re-verify only what stayed unresolved. Two waves is the whole budget. Repair each page once per wave with all of its defects, not once per defect.",
      schema: z.object({}),
    },
  );

  return createMiddleware({
    name: "OpenWikiVerificationMiddleware",
    tools: [verifyWiki],
    wrapModelCall: (request, handler) => {
      const found = (request.tools ?? []).find(
        (candidate: { name?: string }) => candidate.name === "task",
      );
      taskTool ??= (found as unknown as typeof taskTool) ?? null;
      return handler(request);
    },
  });
}
