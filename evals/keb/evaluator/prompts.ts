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
 * One active Truth Package requirement and only the excerpts selected for its
 * coverage judgment.
 */
export interface CoveragePromptTarget {
  /**
   * Stable logical fact identifier.
   */
  factId: string;

  /**
   * Requirement statement currently active at the checkpoint.
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

  /**
   * Identities of source excerpts retrieved for this assertion.
   */
  evidenceIds: string[];
}

/**
 * One source excerpt supplied to a precision judgment.
 */
export interface PrecisionEvidenceExcerpt {
  /**
   * Stable source-adapter-owned evidence identity.
   */
  evidenceId: string;

  /**
   * Human-auditable source location.
   */
  sourceRef: string;

  /**
   * Checkpoint at which this evidence was observed.
   */
  observedAtCheckpoint: string;

  /**
   * Whether this evidence belongs to the active checkpoint.
   */
  current: boolean;

  /**
   * Exact normalized source content.
   */
  content: string;
}

/**
 * System instructions for bounded coverage classification.
 */
export const COVERAGE_SYSTEM = `You are a strict, impartial documentation coverage classifier.

You receive active Truth Package requirements and BM25-selected artifact
excerpts grouped by requirement. You may use any excerpt present in the bounded
request. Do not use outside knowledge. Do not assume access to files, tools, or
source code.

Rules:
- Return exactly one evaluation per requested factId.
- Evidence entries must be sectionId values supplied anywhere in this bounded request.
- "correct" requires the complete material fact to be stated accurately.
- "partial" means an important portion is present but incomplete or imprecise.
- "missing" means these excerpts do not state the fact.
- "contradicted" means these excerpts assert something incompatible with it.
- "missing" may cite supplied excerpts that show related but incomplete
  documentation; evidence is optional because absence may require exhausting
  all supplied sections.
- Return only the structured response.`;

/**
 * System instructions for bounded obsolete-knowledge classification.
 */
export const FORGETTING_SYSTEM = `You are a strict, impartial documentation forgetting classifier.

You receive obsolete Truth Package requirement statements and BM25-selected
artifact excerpts grouped by statement. You may use any excerpt present in the
bounded request. Do not use outside knowledge. Do not assume access to files,
tools, or source code.

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
export const PRECISION_EXTRACTION_SYSTEM = `You are a strict knowledge-artifact assertion extractor.

You receive complete artifact sections. Extract the meaningful, concrete,
checkable knowledge claims that would help an agent or human understand, use,
modify, operate, or troubleshoot the subject. Do not inventory every syntactic
or incidental observation. Do not judge whether a claim is true. Do not use
outside knowledge, files, tools, or source code.

Rules:
- Return exactly one result per supplied sectionId.
- Consolidate closely related statements into one coherent claim when they
  explain one topic or behavior.
- Preserve every material exact detail the artifact states, including names,
  values, behavior, conditions, exceptions, defaults, and constraints. Never
  weaken a specific claim into a vague claim that is easier to support.
- Split claims only when they concern independently meaningful topics or could
  receive different truth judgments.
- Include material behavior, architecture, configuration, APIs, constraints,
  defaults, execution behavior, and operational facts.
- Include assertions in tables, lists, and code examples when surrounding prose
  presents them as actual behavior.
- Exclude headings alone, navigation, transitions, subjective descriptions,
  explicitly hypothetical examples, and statements only about the artifact.
- Exclude page locations, descriptions of what a page covers, documentation
  routing advice, source maps, and page inventories.
- Exclude commit-by-commit narration, change history, and claims about what an
  earlier change touched; precision evaluates current state.
- Exclude repository archaeology and incidental inventory such as commit counts,
  exact file counts, commentary wording, fixture provenance, and absent tooling
  with no material consequence.
- Exclude advice, maintenance instructions, validation recipes, and statements
  about what a contributor or caller should, must, or needs to do.
- Exclude hypotheticals, counterfactuals, future scenarios, and predictions about
  what would happen if the repository changed.
- Exclude editorial characterizations such as "minimal" or "well-behaved"
  unless the same sentence contains a separable concrete material fact; emit
  only that concrete fact.
- Preserve the assertion's meaning without adding facts not stated by the section.
- Return only the structured response.`;

/**
 * System instructions for source-evidence-based precision judgment.
 */
export const PRECISION_JUDGMENT_SYSTEM = `You are a strict source-grounded precision classifier.

You receive material assertions extracted from a knowledge artifact and
source-evidence excerpts retrieved separately for each assertion. Judge only
from the supplied evidence. Do not use outside knowledge, files, tools, or
unstated assumptions.

Rules:
- Return exactly one evaluation per supplied assertionId.
- "supported" requires supplied evidence to establish the complete assertion.
- "contradicted" requires supplied evidence to establish incompatible current
  truth. Mere lack of support is not a contradiction.
- "unverifiable" means the supplied evidence establishes neither support nor
  contradiction.
- Mere consistency is not support, and uncertainty is not contradiction.
- Supported and contradicted results must cite the evidenceIds that establish
  the verdict. Unverifiable results must cite no evidenceIds.
- Evidence IDs must come from that assertion's own supplied evidence.
- Current-state assertions require current evidence. Historical evidence may
  establish explicitly historical claims but must not support a claim that an
  obsolete behavior remains current.
- The rationale must agree with the verdict. If the rationale says the cited
  evidence establishes the assertion, the verdict must be "supported".
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
  return `Extract the meaningful, detail-preserving knowledge claims from each complete section below.

Return exactly one result per sectionId. Return an empty assertions array when a
section contains no material claim.

Sections (JSON):
${JSON.stringify(sections, null, 2)}`;
}

/**
 * Build one bounded precision-judgment task.
 *
 * @param assertions - Extracted assertions paired with source evidence.
 * @param evidence - Deduplicated source excerpts referenced by the assertions.
 *
 * @returns Stable JSON-bearing precision prompt.
 */
export function precisionJudgmentPrompt(
  assertions: PrecisionJudgmentAssertion[],
  evidence: PrecisionEvidenceExcerpt[],
): string {
  return `Judge every assertion against only its supplied source evidence.

Assertions (JSON):
${JSON.stringify(assertions, null, 2)}

Source evidence (JSON):
${JSON.stringify(evidence, null, 2)}`;
}
