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

  /** Temporal stance assigned during extraction. */
  tense: "current" | "historical";

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

  /** Whether this version is active or superseded at the checkpoint. */
  current: boolean;
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
export const PRECISION_EXTRACTION_SYSTEM = `You are a strict, accountable atomic-claim extractor.

You receive code-owned Markdown text units. Classify every supplied unit and
extract only its objectively checkable claims about the underlying subject. Do
not judge whether a claim is true. Do not use outside knowledge, files, tools, or
source code. No supplied unit may disappear.

Classifications:
- "factual": the unit consists of one or more objectively checkable subject claims.
- "mixed": the unit combines checkable subject claims with navigation, opinion,
  instruction, or other non-claim material. Extract only the factual parts.
- "navigation": the unit only routes the reader within the artifact or describes
  subject areas, source locations, pages, sections, maps, or organization.
- "meta-artifact": the unit only describes the wiki or documentation artifact,
  its completeness, organization, generation, or editorial state.
- "opinion": the unit only makes subjective, aesthetic, or evaluative judgments.
- "instruction": the unit only tells a reader what to do, including recommendations,
  procedures, prescriptive policy, or hypothetical future work.
- "no-claim": headings, transitions, fragments, or other content with no claim.

Rules:
- Return exactly one result per supplied unitId.
- "factual" and "mixed" must return at least one assertion. Every other
  classification must return an empty assertions array.
- Every assertion must be atomic: one independently judgeable claim. Split
  compounds whenever their parts could receive different truth judgments.
- Every assertion must be self-contained. Resolve pronouns and implicit referents
  to explicit names without adding facts.
- Preserve exact names, values, behavior, conditions, exceptions, defaults, and
  constraints. Never weaken a specific claim to make it easier to support.
- Tag every assertion "current" when it asserts present world state and
  "historical" only when it explicitly asserts a past state.
- A concrete command's documented behavior may be factual; advice to run it is
  instruction. Example: "Run pnpm test" is instruction; "pnpm test runs Vitest"
  is factual.
- Commit archaeology that only narrates hashes, messages, or edit chronology is
  meta-artifact. A subject-history claim such as "negate was removed in 2.0.0"
  is factual and historical.
- Wiki self-description is meta-artifact. Example: "This wiki documents every
  export" yields no claim, while "src/calc.ts exports add" is factual.
- Editorial asides and recommendations are instruction or opinion. Hypothetical
  future states yield no current fact unless they contain a separable present fact.
- A subjective sentence containing a separable factual claim is "mixed" and must
  retain only the factual claim.
- Preserve meaning without inventing implied intent, policy, or causality.
- Return a concise rationale explaining each classification.
- Return only the structured response.`;

/**
 * System instructions for accounting artifact assertions against requirements.
 */
export const PRECISION_LEDGER_SYSTEM = `You are a strict truth-ledger classifier.

You receive material assertions extracted from a knowledge artifact and the
complete set of human-authored fact versions relevant at the checkpoint. Facts
are marked current or superseded. Judge only against these facts and declared
version history. Do not use source code, outside knowledge, tools, or unstated
assumptions.

Rules:
- Return exactly one evaluation per supplied assertionId.
- "supported" means current facts establish the complete current assertion, or
  superseded facts and their transition to current truth establish an explicitly
  historical assertion.
- Fact versions sharing a factId form one declared history. A superseded version
  with no current version of the same factId declares that the fact was removed;
  a superseded version with a current version declares that it changed.
- "contradicted" means current facts establish incompatible truth.
- "unaccounted" means the facts establish neither support nor contradiction.
- Mere consistency is not support, and ledger silence is not contradiction.
- For every contradicted result, formerlyTrue is true iff superseded fact versions
  establish that the complete assertion was true earlier. Otherwise it is false.
- formerlyTrue is required for contradicted results and must be omitted for
  supported and unaccounted results.
- Supported and contradicted results must cite the factVersionIds that establish
  the verdict. A contradicted result with formerlyTrue=true must also cite the
  superseded factVersionIds establishing former truth. Unaccounted results cite none.
- The rationale must agree with the verdict.
- Return only the structured response.`;

/**
 * System instructions for source-evidence-based precision judgment.
 */
export const PRECISION_JUDGMENT_SYSTEM = `You are a strict source-grounded refutation classifier.

You receive material assertions extracted from a knowledge artifact and a
deduplicated source-evidence set shared by the bounded judgment batch. Each
assertion lists the exact evidence IDs it may use. Judge only from the supplied
evidence. Do not use unavailable files, tools, project facts, or changing outside
information. You may apply ordinary language and runtime semantics needed to
interpret supplied source code, such as arithmetic and direct control flow.

Rules:
- Return exactly one evaluation per supplied assertionId.
- "contradicted" requires supplied evidence to establish incompatible truth.
- "not-refuted" means supplied evidence does not establish incompatible truth.
  It does not mean the assertion is supported.
- Absence of evidence is never contradiction. Never certify an assertion true.
- Contradicted results must cite the evidenceIds that establish incompatible
  current truth. Not-refuted results cite no evidenceIds.
- Evidence IDs must come from that assertion's own supplied evidence.
- Current-state contradiction requires current evidence. For every contradicted
  result, formerlyTrue is true iff supplied historical evidence establishes the
  complete assertion at an earlier checkpoint; otherwise it is false. Cite the
  historical evidence IDs as well when formerlyTrue is true.
- formerlyTrue is required for contradicted results and must be omitted for
  not-refuted results.
- The rationale must agree with the verdict. Never return "contradicted" while
  explaining that it is not refuted.
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
  return `Classify every text unit and extract atomic, self-contained, detail-preserving factual subject claims with current or historical tense.

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
  return `Attempt to refute every assertion using only its supplied source evidence. Never certify support.

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
  assertions: Array<{
    assertionId: string;
    statement: string;
    tense: "current" | "historical";
  }>,
  facts: PrecisionLedgerFact[],
): string {
  return `Account for every assertion against the complete current and superseded truth ledger.

Assertions (JSON):
${JSON.stringify(assertions, null, 2)}

Complete truth ledger (JSON):
${JSON.stringify(facts, null, 2)}`;
}
