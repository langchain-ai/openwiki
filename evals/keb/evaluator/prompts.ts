/**
 * Version of the evaluator prompts and logic. This remains at v2 until the full
 * bounded evaluator replaces the legacy precision agent in Phase 5.
 */
export const PROMPT_VERSION = "keb-eval-2";

/**
 * One artifact excerpt supplied directly to a bounded evaluator request.
 */
export interface EvaluationExcerpt {
  /**
   * Stable artifact-section identifier used for evidence citations.
   */
  sectionId: string;

  /**
   * Wiki path from which the excerpt was sectioned.
   */
  relativePath: string;

  /**
   * Active heading hierarchy for the excerpt.
   */
  headingPath: string[];

  /**
   * Exact Markdown content of the excerpt.
   */
  content: string;
}

/**
 * One active Truth Ledger fact and only the excerpts selected for its coverage
 * judgment.
 */
export interface CoveragePromptTarget {
  /**
   * Stable logical fact identifier.
   */
  factId: string;

  /**
   * Fact statement currently true in the ledger.
   */
  statement: string;

  /**
   * Artifact excerpts the model may use for this fact.
   */
  excerpts: EvaluationExcerpt[];
}

/**
 * One obsolete fact version and only the excerpts selected for its forgetting
 * judgment.
 */
export interface ForgettingPromptTarget {
  /**
   * Stable identifier of the obsolete fact version.
   */
  factVersionId: string;

  /**
   * Statement that is no longer current truth.
   */
  obsoleteStatement: string;

  /**
   * Artifact excerpts the model may use for this fact version.
   */
  excerpts: EvaluationExcerpt[];
}

/**
 * System instructions for bounded coverage classification.
 */
export const COVERAGE_SYSTEM = `You are a strict, impartial documentation coverage classifier.

You receive active Truth Ledger facts and a separate set of generated-wiki
excerpts for each fact. Judge only the excerpts supplied for that fact. Do not
use outside knowledge. Do not assume access to files, tools, or source code.

Rules:
- Return exactly one evaluation per requested factId.
- Evidence entries must be sectionId values supplied for that same fact.
- "correct" requires the complete material fact to be stated accurately.
- "partial" means an important portion is present but incomplete or imprecise.
- "missing" means these excerpts do not state the fact.
- "contradicted" means these excerpts assert something incompatible with it.
- Return only the structured response.`;

/**
 * System instructions for bounded obsolete-knowledge classification.
 */
export const FORGETTING_SYSTEM = `You are a strict, impartial documentation forgetting classifier.

You receive obsolete Truth Ledger statements and a separate set of generated-
wiki excerpts for each statement. Judge only the excerpts supplied for that
fact version. Do not use outside knowledge. Do not assume access to files,
tools, or source code.

Rules:
- Return exactly one evaluation per requested factVersionId.
- Evidence entries must be sectionId values supplied for that same version.
- "lingering" means an excerpt still presents the obsolete statement as current truth.
- "forgotten" means these excerpts do not present it as current truth.
- A historical statement such as "this option was removed" is not lingering.
- A migration warning or explicit description of former behavior is not lingering
  unless it also says the obsolete behavior remains current.
- Return only the structured response.`;

/**
 * Legacy precision-agent instructions retained only until Phase 4 replaces
 * precision extraction and judgment with bounded direct calls.
 */
export const PRECISION_SYSTEM = `You are a strict, impartial documentation evaluator.

You are given read-only access to an evaluation workspace through filesystem
tools (ls, read_file, glob, grep). The generated wiki is under "/artifact". You
do not know which system produced this wiki; judge only what is written.

Rules:
- Read the wiki before judging. Use glob("artifact/**/*.md") and grep to locate
  content.
- Cite the workspace-relative path of every file you rely on.
- Judge only what the wiki actually states, not what you assume it means.
- Return your answer only through the structured response format.`;

/**
 * Build one bounded coverage-classification task.
 *
 * @param targets - Active facts paired with their own candidate excerpts.
 *
 * @returns Stable JSON-bearing task prompt.
 */
export function coveragePrompt(targets: CoveragePromptTarget[]): string {
  return `Judge coverage for every target below using only that target's supplied excerpts.

Return exactly one evaluation per factId with verdict, evidence, and rationale.

Targets (JSON):
${JSON.stringify(targets, null, 2)}`;
}

/**
 * Build one bounded obsolete-knowledge-classification task.
 *
 * @param targets - Obsolete versions paired with their own candidate excerpts.
 *
 * @returns Stable JSON-bearing task prompt.
 */
export function forgettingPrompt(targets: ForgettingPromptTarget[]): string {
  return `Judge forgetting for every target below using only that target's supplied excerpts.

Return exactly one evaluation per factVersionId with verdict, evidence, and rationale.

Targets (JSON):
${JSON.stringify(targets, null, 2)}`;
}

/**
 * Build the legacy precision task retained until bounded precision lands in
 * Phase 4.
 *
 * @returns Legacy precision-agent task prompt.
 */
export function precisionPrompt(): string {
  return `Read every document under "/artifact" and extract each unique,
material assertion the wiki makes (a concrete, checkable claim about behavior,
structure, configuration, or APIs; ignore vague or purely navigational text).
Deduplicate assertions that say the same thing.

Read the active Truth Ledger at "/truth-ledger.json". It lists the facts that
are true at this checkpoint, each with a factId and statement. The ledger is the
sole source of truth: it is meant to be complete, so an assertion the ledger
does not positively establish is treated as unsupported, not as merely
unaddressed. Judge every unique material assertion against that ledger:

- "supported": one or more ledger facts positively establish the assertion.
- "unsupported": the ledger contradicts the assertion or is silent on it.

Support must come only from the ledger text. Do not use outside knowledge or
source code. Evaluate all unique material assertions; do not sample. Cite each
assertion's location as a workspace-relative path under artifact/.`;
}
