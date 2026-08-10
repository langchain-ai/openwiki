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
 * One code-owned Markdown text unit supplied for accountable classification and
 * factual-claim extraction.
 */
export interface PrecisionExtractionUnit {
  /**
   * Stable text-unit identifier that the classifier must return.
   */
  unitId: string;

  /**
   * Stable artifact-section identifier owning the unit.
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
   * Exact Markdown block to classify and inspect for factual assertions.
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
   * Identities of source excerpts visible to this assertion in the bounded
   * judgment batch.
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
 * One active human-authored requirement supplied for assertion accounting.
 */
export interface PrecisionLedgerFact {
  /**
   * Stable logical requirement identity.
   */
  factId: string;

  /**
   * Stable identity of the requirement version active at this checkpoint.
   */
  factVersionId: string;

  /**
   * Complete required statement active at this checkpoint.
   */
  statement: string;
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
export const PRECISION_EXTRACTION_SYSTEM = `You are a strict, accountable knowledge-claim classifier.

You receive code-owned Markdown text units. Classify every supplied unit and
extract only its objectively checkable claims about the underlying subject. Do
not judge whether a claim is true. Do not use outside knowledge, files, tools, or
source code. No supplied unit may disappear.

Classifications:
- "factual": the unit consists of one or more objectively checkable subject claims.
- "mixed": the unit combines checkable subject claims with navigation, opinion,
  instruction, or other non-claim material. Extract only the factual parts.
- "navigation": the unit only routes the reader within the artifact or describes
  artifact pages, sections, maps, or organization.
- "opinion": the unit only makes subjective, aesthetic, or evaluative judgments.
- "instruction": the unit only tells a reader what to do without asserting an
  objectively checkable command, behavior, requirement, or consequence.
- "no-claim": headings, transitions, fragments, or other content with no claim.

Rules:
- Return exactly one result per supplied unitId.
- "factual" and "mixed" must return at least one assertion. Every other
  classification must return an empty assertions array.
- Preserve exact names, values, behavior, conditions, exceptions, defaults, and
  constraints. Never weaken a specific claim to make it easier to support.
- Split independent claims that could receive different truth judgments.
- A command or procedure is factual when it claims that a concrete command works,
  is required, or produces a result. Pure recommendations are instructions.
- Useful domain history such as an API being removed may be factual. Incidental
  commit hashes, commit messages, file counts, and change archaeology are not
  subject claims.
- Statements about the artifact itself are navigation, not source-domain facts.
- A subjective sentence containing a separable factual claim is "mixed" and must
  retain only the factual claim.
- Preserve meaning without inventing implied intent, policy, or causality.
- Return a concise rationale explaining each classification.
- Return only the structured response.`;

/**
 * System instructions for accounting artifact assertions against requirements.
 */
export const PRECISION_LEDGER_SYSTEM = `You are a strict benchmark-ledger classifier.

You receive material assertions extracted from a knowledge artifact and the
complete set of human-authored requirements active at the checkpoint. Judge only
against these requirements. Do not use source code, outside knowledge, tools, or
unstated assumptions.

Rules:
- Return exactly one evaluation per supplied assertionId.
- "supported" means one or more active requirements establish the complete assertion.
- "contradicted" means one or more active requirements establish incompatible truth.
- "unaccounted" means the requirements establish neither support nor contradiction.
- Mere consistency is not support, and ledger silence is not contradiction.
- Supported and contradicted results must cite the factVersionIds that establish
  the verdict. Unaccounted results must cite no factVersionIds.
- The rationale must agree with the verdict.
- Return only the structured response.`;

/**
 * System instructions for source-evidence-based precision judgment.
 */
export const PRECISION_JUDGMENT_SYSTEM = `You are a strict source-grounded precision classifier.

You receive material assertions extracted from a knowledge artifact and a
deduplicated source-evidence set shared by the bounded judgment batch. Each
assertion lists the exact evidence IDs it may use. Judge only from the supplied
evidence. Do not use unavailable files, tools, project facts, or changing outside
information. You may apply ordinary language and runtime semantics needed to
interpret supplied source code, such as arithmetic and direct control flow.

Rules:
- Return exactly one evaluation per supplied assertionId.
- "supported" requires supplied evidence, including its direct deterministic
  consequences, to establish the complete assertion.
- "contradicted" requires supplied evidence to establish incompatible truth.
- "not-supported" means the complete assertion is not established and no
  supplied evidence directly proves an incompatible alternative.
- A record that explicitly identifies itself as a complete inventory is
  closed-world evidence for paths absent from that inventory. Combine it with
  supplied file contents when judging repository-wide absence claims.
- Supported and contradicted results must cite the evidenceIds that establish
  the verdict. Not-supported results must cite no evidenceIds.
- Evidence IDs must come from that assertion's own supplied evidence.
- Current-state assertions require current evidence. Historical evidence may
  establish explicitly historical claims but must not support a claim that an
  obsolete behavior remains current.
- The rationale must agree with the verdict. Never return "contradicted" while
  explaining that the assertion is supported, or vice versa.
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
 * @param units - Complete code-owned text units to classify.
 *
 * @returns Stable JSON-bearing extraction prompt.
 */
export function precisionExtractionPrompt(
  units: PrecisionExtractionUnit[],
): string {
  return `Classify every text unit and extract its detail-preserving factual subject claims.

Return exactly one result per unitId. Follow the classification/assertion rules
from the system instructions.

Text units (JSON):
${JSON.stringify(units, null, 2)}`;
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

/**
 * Build one complete requirement-accounting task.
 *
 * @param assertions - Extracted assertions to account for.
 * @param facts - Complete active requirement set.
 *
 * @returns Stable JSON-bearing ledger prompt.
 */
export function precisionLedgerPrompt(
  assertions: Array<{ assertionId: string; statement: string }>,
  facts: PrecisionLedgerFact[],
): string {
  return `Account for every assertion against the complete active requirement ledger.

Assertions (JSON):
${JSON.stringify(assertions, null, 2)}

Complete active requirement ledger (JSON):
${JSON.stringify(facts, null, 2)}`;
}
