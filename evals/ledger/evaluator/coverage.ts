import type { FactEvaluation, SurfaceItem } from "../core/types.js";
import {
  runBoundedPass,
  resolvePass,
  type BoundedPassRuntime,
  type BoundedPassSpec,
} from "./bounded-pass.js";
import { toExcerpt } from "./pass-utils.js";
import { COVERAGE_SYSTEM, coveragePrompt } from "./prompts.js";
import { coverageOutputSchema } from "./schemas.js";
import type { CoverageOutput } from "./schemas.js";

/**
 * Inputs for the bounded coverage pass: the runtime shared by every pass plus
 * the surface this pass classifies.
 */
export interface CoveragePassInput extends BoundedPassRuntime {
  /**
   * Public source surface extracted at the checkpoint: the items the wiki is
   * expected to mention.
   */
  surface: SurfaceItem[];
}

/**
 * The coverage pass definition. Coverage keys on `factId`, ranks sections by a
 * requirement's current statement, and starts every requirement at the
 * evidence-free `missing` verdict; any other verdict must cite a section.
 */
const coverageSpec: BoundedPassSpec<
  SurfaceItem,
  CoverageOutput,
  CoverageOutput["evaluations"][number],
  FactEvaluation
> = {
  passName: "coverage",
  label: "Coverage",
  idLabel: "factId",
  system: COVERAGE_SYSTEM,
  negativeVerdict: "missing",
  schema: coverageOutputSchema,
  buildPrompt: (targets) =>
    coveragePrompt(
      targets.map(({ fact, sections }) => ({
        factId: fact.factId,
        statement: fact.statement,
        excerpts: sections.map(toExcerpt),
      })),
    ),
  targetId: (fact) => fact.factId,
  searchText: (fact) => fact.statement,
  itemId: (item) => item.factId,
  resultId: (result) => result.factId,
  makeResult: ({ fact, verdict, evidence, rationale }) => ({
    factId: fact.factId,
    factVersionId: fact.factVersionId,
    verdict: verdict as FactEvaluation["verdict"],
    evidence,
    rationale,
  }),
};

/**
 * Resolve raw coverage output into exactly one evaluation per requested surface
 * item. Unknown fact IDs, duplicate verdicts, and missing verdicts are
 * evaluation failures rather than implicit defaults.
 *
 * @param surface - Surface items requested from the classifier.
 * @param output - Parsed classifier output.
 *
 * @returns One evaluation per surface item in request order.
 *
 * @throws EvaluationError when output identity or completeness is invalid.
 */
export function resolveCoverage(
  surface: SurfaceItem[],
  output: CoverageOutput,
): FactEvaluation[] {
  return resolvePass(coverageSpec, surface, output);
}

/**
 * Run bounded coverage classification with BM25-first evidence and exhaustive
 * fallback before any `missing` verdict becomes final.
 *
 * @param input - Coverage pass configuration.
 *
 * @returns One coverage verdict per surface item in surface order.
 */
export function runCoveragePass(
  input: CoveragePassInput,
): Promise<FactEvaluation[]> {
  return runBoundedPass(coverageSpec, input, input.surface);
}
