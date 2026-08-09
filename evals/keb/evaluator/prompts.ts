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
 * One complete artifact section supplied for assertion extraction.
 */
export interface PrecisionExtractionSection {
  /**
   * Stable artifact-section identifier.
   */
  sectionId: string;

  /**
   * Wiki path from which the section was produced.
   */
  relativePath: string;

  /**
   * Active heading hierarchy for the section.
   */
  headingPath: string[];

  /**
   * Exact Markdown content to inspect for material assertions.
   */
  content: string;
}

/**
 * One code-owned extracted assertion supplied for precision judgment.
 */
export interface PrecisionJudgmentAssertion {
  /**
   * Deterministic assertion identifier.
   */
  assertionId: string;

  /**
   * Atomic material assertion extracted from the artifact.
   */
  statement: string;
}

/**
 * One active Truth Ledger fact supplied as the complete source of truth for
 * precision judgment.
 */
export interface PrecisionJudgmentFact {
  /**
   * Stable logical fact identifier.
   */
  factId: string;

  /**
   * Fact statement currently true at the checkpoint.
   */
  statement: string;
}

/**
 * System instructions for bounded coverage classification.
 */
export const COVERAGE_SYSTEM = `You are a strict, impartial documentation coverage classifier.

You receive active Truth Ledger facts and BM25-selected generated-wiki excerpts
grouped by fact. You may use any excerpt present in the bounded request. Do not
use outside knowledge. Do not assume access to files, tools, or source code.

Rules:
- Return exactly one evaluation per requested factId.
- Evidence entries must be sectionId values supplied anywhere in this bounded request.
- "correct" requires the complete material fact to be stated accurately.
- "partial" means an important portion is present but incomplete or imprecise.
- "missing" means these excerpts do not state the fact.
- "contradicted" means these excerpts assert something incompatible with it.
- Return only the structured response.`;

/**
 * System instructions for bounded obsolete-knowledge classification.
 */
export const FORGETTING_SYSTEM = `You are a strict, impartial documentation forgetting classifier.

You receive obsolete Truth Ledger statements and BM25-selected generated-wiki
excerpts grouped by statement. You may use any excerpt present in the bounded
request. Do not use outside knowledge. Do not assume access to files, tools, or
source code.

Rules:
- Return exactly one evaluation per requested factVersionId.
- Evidence entries must be sectionId values supplied anywhere in this bounded request.
- "lingering" means an excerpt still presents the obsolete statement as current truth.
- "forgotten" means these excerpts do not present it as current truth.
- "lingering" must cite at least one excerpt containing the obsolete current claim.
- "forgotten" may cite supplied excerpts that establish replacement, removal, or
  historical-only treatment, but evidence is optional because absence may require
  exhausting all supplied sections.
- A historical statement such as "this option was removed" is not lingering.
- A migration warning or explicit description of former behavior is not lingering
  unless it also says the obsolete behavior remains current.
- Return only the structured response.`;

/**
 * System instructions for exhaustive assertion extraction.
 */
export const PRECISION_EXTRACTION_SYSTEM = `You are a strict documentation assertion extractor.

You receive complete generated-wiki sections. Extract every atomic, concrete,
checkable assertion each section makes about the repository's current state at
this checkpoint. Do not judge whether an assertion is true. Do not use outside
knowledge, files, tools, or source code.

Rules:
- Return exactly one result per supplied sectionId.
- Keep assertions atomic: split independently checkable facts.
- Include behavior, structure, configuration, APIs, constraints, defaults,
  execution behavior, and operational facts.
- Include assertions in tables, lists, and code examples when surrounding prose
  presents them as actual repository behavior.
- Exclude headings alone, navigation, transitions, subjective descriptions,
  explicitly hypothetical examples, and statements only about the wiki itself.
- Exclude page locations, descriptions of what a page covers, documentation
  routing advice, source maps, and page inventories.
- Exclude commit-by-commit narration, change history, and claims about what an
  earlier commit touched; precision evaluates current repository state.
- Exclude advice, maintenance instructions, validation recipes, and statements
  about what a contributor or caller should, must, or needs to do.
- Exclude hypotheticals, counterfactuals, future scenarios, and predictions about
  what would happen if the repository changed.
- Exclude editorial characterizations such as "minimal" or "well-behaved"
  unless the same sentence contains a separable concrete repository fact; emit
  only that concrete fact.
- Preserve the assertion's meaning without adding facts not stated by the section.
- Return only the structured response.`;

/**
 * System instructions for Truth-Ledger-based precision judgment.
 */
export const PRECISION_JUDGMENT_SYSTEM = `You are a strict documentation precision classifier.

You receive material assertions extracted from a generated wiki and the complete
active Truth Ledger. The ledger is the sole source of truth. Judge only whether
the ledger positively establishes each assertion. Do not use outside knowledge,
files, tools, or source code.

Rules:
- Return exactly one evaluation per supplied assertionId.
- "supported" requires one or more active ledger facts to positively establish
  the complete assertion.
- Combine multiple ledger facts when together they establish the assertion.
- Mere consistency is not support.
- Ledger silence is "unsupported", even if the assertion may be true in reality.
- A contradiction with the ledger is "unsupported".
- A supported result must name every supporting factId needed for support.
- An unsupported result must have no supportingFactIds.
- The rationale must agree with the verdict. If the rationale says the cited
  facts establish the assertion, the verdict must be "supported".
- Return only the structured response.`;

/**
 * Build one bounded coverage-classification task.
 *
 * @param targets - Active facts paired with BM25-selected candidate excerpts.
 *
 * @returns Stable JSON-bearing task prompt.
 */
export function coveragePrompt(targets: CoveragePromptTarget[]): string {
  return `Judge coverage for every target below using only excerpts supplied anywhere in this bounded request.

Return exactly one evaluation per factId with verdict, evidence, and rationale.

Targets (JSON):
${JSON.stringify(targets, null, 2)}`;
}

/**
 * Build one bounded obsolete-knowledge-classification task.
 *
 * @param targets - Obsolete versions paired with BM25-selected candidate excerpts.
 *
 * @returns Stable JSON-bearing task prompt.
 */
export function forgettingPrompt(targets: ForgettingPromptTarget[]): string {
  return `Judge forgetting for every target below using only excerpts supplied anywhere in this bounded request.

Return exactly one evaluation per factVersionId with verdict, evidence, and rationale.

Targets (JSON):
${JSON.stringify(targets, null, 2)}`;
}

/**
 * Build one bounded assertion-extraction task.
 *
 * @param sections - Complete artifact sections to inspect.
 *
 * @returns Stable JSON-bearing extraction prompt.
 */
export function precisionExtractionPrompt(
  sections: PrecisionExtractionSection[],
): string {
  return `Extract every material assertion from each complete section below.

Return exactly one result per sectionId. Return an empty assertions array when a
section contains no material repository assertion.

Sections (JSON):
${JSON.stringify(sections, null, 2)}`;
}

/**
 * Build one bounded precision-judgment task.
 *
 * @param assertions - Extracted assertions to classify.
 * @param activeFacts - Complete active Truth Ledger.
 *
 * @returns Stable JSON-bearing precision prompt.
 */
export function precisionJudgmentPrompt(
  assertions: PrecisionJudgmentAssertion[],
  activeFacts: PrecisionJudgmentFact[],
): string {
  return `Judge every assertion against the complete active Truth Ledger below.

Assertions (JSON):
${JSON.stringify(assertions, null, 2)}

Complete active Truth Ledger (JSON):
${JSON.stringify(activeFacts, null, 2)}`;
}
