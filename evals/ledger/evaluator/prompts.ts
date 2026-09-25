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

  /** Exact artifact text from which the normalized statement was extracted. */
  sourceQuote: string;

  /** Identity of the full artifact unit that constrains the quote's meaning. */
  artifactContextId: string;

  /**
   * Temporal stance assigned during extraction.
   */
  tense: "current" | "historical";

  /**
   * Identities of source excerpts visible to this assertion in the bounded
   * judgment batch.
   */
  evidenceIds: string[];
}

/** One deduplicated artifact unit supplied to preserve assertion semantics. */
export interface PrecisionArtifactContext {
  /** Stable text-unit identity referenced by extracted assertions. */
  contextId: string;

  /** Wiki path owning the unit. */
  relativePath: string;

  /** Active heading hierarchy at the unit. */
  headingPath: string[];

  /** Exact Markdown content of the full text unit. */
  content: string;
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
 * System instructions for bounded obsolete-knowledge classification.
 */
export const FORGETTING_SYSTEM = `You are a strict, impartial documentation forgetting classifier.

You receive obsolete source-surface statements and BM25-selected
artifact excerpts grouped by statement. You may use any excerpt present in the
bounded request. Do not use outside knowledge. Do not assume access to files,
tools, or source code.

For each statement write the rationale first and cite evidence, then name the
verdict last, emitting fields in that schema order. The verdict must match the
conclusion the rationale reached; never leave a label standing against your own
reasoning.

Rules:
- Return exactly one evaluation per requested factVersionId.
- Evidence entries must be sectionId values supplied anywhere in this bounded request.
- Each target is one exact obsolete fact version, not merely a symbol, type,
  concept, file, or page identity.
- "lingering" means an excerpt affirmatively presents the material details of
  that exact obsolete version as current truth.
- "forgotten" means these excerpts do not present it as current truth.
- A generic mention of the same name is insufficient for "lingering". A current
  replacement signature, behavior, meaning, or source path does not preserve an
  obsolete version merely because it shares a name.
- Mere compatibility with the obsolete version is also insufficient. A usage
  example that remains valid under both the obsolete and current versions does
  not assert the obsolete version.
- The cited excerpt and matchedText must establish the complete obsolete
  statement, including every version-distinguishing parameter, default, return
  type, path, behavior, or meaning. If any such detail is absent, ambiguous, or
  only consistent with the obsolete version, return "forgotten".
- If the rationale says the excerpt does not provide the full obsolete signature
  or another material obsolete detail, the verdict must be "forgotten".
- A link to or mention of an artifact page does not assert that a similarly named
  source file currently exists unless the excerpt says so.
- "lingering" must cite at least one excerpt and return matchedText: the smallest
  exact verbatim span from a cited excerpt that presents the material obsolete
  details as current. A name alone is not sufficient matchedText.
- "forgotten" may cite supplied excerpts that establish replacement, removal, or
  historical-only treatment, but evidence is optional because absence may require
  exhausting all supplied sections.
- "forgotten" must omit matchedText.
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
- Do not split a compound when a shared qualifier or quantifier such as "only",
  "none", "both", a comparison, or a condition would change scope. Preserve the
  complete qualified claim rather than distributing the qualifier across parts.
- Every assertion must be self-contained. Resolve pronouns and implicit referents
  to explicit names without adding facts.
- Never emit an unresolved deictic subject such as "this file", "this module",
  "the function", or "it". Resolve it from the complete supplied unit and heading
  context. If that context does not identify the referent, do not extract that
  clause rather than guessing.
- Repeat a shared subject or negation across independently judgeable clauses when
  doing so preserves the original meaning. For example,
  "test/queue.test.ts never imports worker.ts or store modules and never constructs
  TaskError" becomes three assertions: the test does not import worker.ts, the
  test does not import store modules, and the test does not construct TaskError.
- Every assertion must include sourceQuote: the smallest exact contiguous
  verbatim span from the supplied unit that supports the complete statement.
  Never synthesize, normalize, or remove Markdown inside sourceQuote.
- The normalized statement must be fully entailed by sourceQuote in the context
  of the complete supplied unit. Preserve local scope from table headers, row
  labels, captions, lists, and surrounding prose; never broaden a locally scoped
  claim into a repository-wide one.
- Preserve exact names, values, behavior, conditions, exceptions, defaults, and
  constraints. Never weaken a specific claim to make it easier to support.
- Tag every assertion "current" when it asserts present world state and
  "historical" only when it explicitly asserts a past state.
- Determine tense from the complete unit and heading context, not one isolated
  clause. Claims inside narration about an original, earlier, removed, renamed,
  or replaced implementation are historical even when a subordinate clause uses
  present grammar.
- Past-tense change narration such as "subtract was added" or "negate was
  removed" is historical even when the described change still matters now.
- A concrete command's documented behavior may be factual; advice to run it is
  instruction. Example: "Run pnpm test" is instruction; "pnpm test runs Vitest"
  is factual.
- Commit archaeology that only narrates hashes, messages, or edit chronology is
  meta-artifact. A subject-history claim such as "negate was removed in 2.0.0"
  is factual and historical.
- Wiki self-description is meta-artifact. Example: "This wiki documents every
  export" yields no claim, while "src/calc.ts exports add" is factual.
- Statements about what generated wiki pages, sections, maps, or documentation
  files describe are meta-artifact. Example: "the generated API page describes purity"
  yields no claim. Statements about the underlying source README or code remain
  factual when they assert source-owned content.
- Editorial asides and recommendations are instruction or opinion. Hypothetical
  future states yield no current fact unless they contain a separable present fact.
- A subjective sentence containing a separable factual claim is "mixed" and must
  retain only the factual claim.
- Diagram state names and labels may be conceptual descriptions. Do not turn
  them into formal runtime fields or enum states when the caption or surrounding
  prose qualifies that interpretation.
- Preserve meaning without inventing implied intent, policy, or causality.
- For each unit write the rationale first and then name the classification,
  emitting fields in that schema order. The classification must match the
  conclusion the rationale reached.
- Return a concise rationale explaining each classification.
- Return units and assertions as actual JSON arrays, never as JSON-encoded strings.
- Return only the structured response.`;

/**
 * System instructions for source-evidence-based precision judgment.
 */
export const PRECISION_JUDGMENT_SYSTEM = `You are a strict, impartial source-grounding classifier.

You receive material assertions extracted from a knowledge artifact and a
deduplicated source-evidence set shared by the bounded judgment batch. Each
assertion also carries an exact sourceQuote and references its complete artifact
context. Use them to preserve the assertion's original scope, tense, and meaning.
Each evidence excerpt is marked current (drawn from the checkpoint under evaluation)
or historical (drawn from an earlier checkpoint). Each assertion lists the exact
evidence IDs it may use. Judge only from the supplied evidence. Do not use
unavailable files, tools, project facts, or changing outside information. You may
apply ordinary language and runtime semantics needed to interpret supplied source
code, such as arithmetic and direct control flow.

Judge each assertion against the evidence with one of three verdicts:
- "supported": the supplied evidence establishes the assertion. For a current
  assertion, current evidence must establish it. For a historical assertion, the
  evidence must establish that it held at the earlier checkpoint it describes.
- "contradicted": the supplied evidence establishes an incompatible truth.
- "not-addressed": the evidence neither establishes the assertion nor establishes
  something incompatible with it.

Decide in this order for every assertion. First write the rationale: reason from
the cited evidence to a single conclusion, and finish that reasoning before you
name a verdict. Then set the verdict to the conclusion the rationale reached.
Emit each field in the order the response schema lists them (rationale, then
evidenceIds, then verdict) and never revise the reasoning after naming the
verdict. The verdict is your final answer, not a first guess: if the rationale
argues the claim matches the source, the verdict is "supported"; do not leave a
"contradicted" or "not-addressed" label standing against your own conclusion.

Rules:
- Return exactly one evaluation per supplied assertionId.
- Before grounding, verify that the normalized statement is faithfully entailed
  by sourceQuote in its complete artifact context. If extraction dropped or
  redistributed a qualifier, broadened table/list scope, formalized a conceptual
  diagram label, or assigned current tense to historical narration, return
  "not-addressed" with no evidence. Do not accuse the artifact of a claim its
  original text does not make.
- Mere consistency is not support, and silence is not contradiction. Missing
  evidence for a location, wording, attribution, timing detail, or one part of a
  compound claim is "not-addressed", not "contradicted", unless the evidence
  affirmatively establishes an incompatible detail.
- A claim about the artifact's own provenance or authoring process, an
  interpretive gloss or generalization, or a negative-existential claim ("there
  is no X anywhere") is "not-addressed" whenever the bounded evidence does not
  affirmatively establish an incompatible fact. Do not mark such a claim
  "contradicted" merely because the evidence does not mention it.
- Use the narrow ordinary scope of the assertion. "Exports a single function"
  means exactly one function export; it does not mean the module has no class,
  type, or value exports. A test's internal source import does not establish how
  package consumers import the published package.
- For claims about executable behavior, direct implementation and control flow
  outrank comments, README prose, names, and stated intent when they conflict.
  For example, push followed by pop on the same array is LIFO even when comments
  call it FIFO, and a function whose only executable operation is void task is a
  no-op for task execution. Descriptive prose remains authoritative for claims
  specifically about what that prose documents or intends.
- "supported" and "contradicted" must cite the evidenceIds that establish the
  verdict. "not-addressed" must cite no evidenceIds.
- Evidence IDs must come from that assertion's own supplied evidence.
- Current-state contradiction requires current evidence. For every contradicted
  result, formerlyTrue is true iff supplied historical evidence establishes the
  complete assertion at an earlier checkpoint; otherwise it is false. Cite the
  historical evidence IDs as well when formerlyTrue is true.
- Historical evidence must entail the same complete assertion, not merely contain
  the same names or remain compatible with it. If materially identical current
  and historical implementation both refute the claim, formerlyTrue is false.
- formerlyTrue is required for contradicted results and must be omitted for
  supported and not-addressed results.
- The verdict must agree with the conclusion of the rationale.
- Never infer that a generated artifact page is absent because it is not listed
  among source-repository files; source evidence and artifact files are separate
  namespaces.
- Return evaluations and evidenceIds as actual JSON arrays, never as JSON-encoded
  strings.
- Return only the structured response.`;

/**
 * System instructions for the second, contradiction-only historical check.
 * Current source has already established an incompatible truth; this pass asks
 * only whether the complete claim was true at an earlier checkpoint.
 */
export const PRECISION_HISTORY_JUDGMENT_SYSTEM = `${PRECISION_JUDGMENT_SYSTEM}

This is a former-truth follow-up. Every supplied excerpt is historical, and the
current source has already contradicted each assertion. Judge only whether the
complete assertion was established at any earlier checkpoint:
- Return "supported" when historical evidence establishes the complete claim.
- Return "not-addressed" when it does not.
- Never return "contradicted" in this follow-up.
- Omit formerlyTrue; the caller derives stale versus invented from this result.`;

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
  artifactContexts: PrecisionArtifactContext[],
): string {
  return `Ground every assertion against only its supplied source evidence, returning supported, contradicted, or not-addressed.

Assertions (JSON):
${JSON.stringify(assertions, null, 2)}

Artifact contexts (JSON):
${JSON.stringify(artifactContexts, null, 2)}

Source evidence (JSON):
${JSON.stringify(evidence, null, 2)}`;
}
