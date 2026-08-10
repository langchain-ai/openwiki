// ---------------------------------------------------------------------------
// Benchmark and trace
// ---------------------------------------------------------------------------

/**
 * A single point in the Evolution Trace. Checkpoints are ordered; index 0 is the
 * initial state evaluated after `init`, and every later index is evaluated after
 * an `update`.
 */
export interface LedgerCheckpoint {
  /**
   * Stable identifier used to reference this checkpoint from Truth Package
   * (for example `"T0"`, `"T3"`). Unique within a benchmark.
   */
  id: string;

  /**
   * Full or abbreviated Git commit SHA in the source repository that this
   * checkpoint checks out. Validated against `/^[0-9a-f]{7,40}$/`.
   */
  commit: string;

  /**
   * Human-readable label for reports, for example `"add retry middleware"`.
   *
   * @default the commit subject is used when omitted
   */
  label?: string;
}

/**
 * The ordered sequence of checkpoints for a benchmark. The trace is frozen: the
 * same commits produce the same replay every run.
 */
export interface LedgerTrace {
  /**
   * Checkpoints in evolution order. Length >= 1. Index 0 is the `init` point.
   */
  checkpoints: LedgerCheckpoint[];
}

/**
 * One version of a fact, valid across a half-open range of checkpoints. A fact's
 * versions partition the trace: exactly one version (or none) is active at any
 * checkpoint.
 */
export interface TruthFactVersion {
  /**
   * The correct statement of the fact while this version is active. This is what
   * the wiki should say. Written as a self-contained claim, not a diff.
   */
  statement: string;

  /**
   * Human-auditable source references grounding this requirement version. The
   * source adapter determines how references such as paths or message IDs map to
   * evidence records.
   */
  evidenceRefs?: string[];

  /**
   * Checkpoint id at which this version becomes true (inclusive).
   */
  fromCheckpoint: string;

  /**
   * Checkpoint id at which this version stops being true (exclusive). Absent
   * means the version remains true through the final checkpoint.
   *
   * @default the version stays active through the end of the trace
   */
  untilCheckpoint?: string;
}

/**
 * A single unit of ground-truth knowledge tracked across the whole trace. A fact
 * may change wording over time (multiple versions), may be introduced partway
 * through, and may be removed. The evaluator never sees this structure directly;
 * LEDGER projects the active version at each checkpoint.
 */
export interface TruthFact {
  /**
   * Stable identifier, unique within the benchmark, used to correlate evaluator
   * verdicts back to the requirements across checkpoints.
   */
  id: string;

  /**
   * Short category used only for reporting and slicing results, for example
   * `"architecture"`, `"api"`, `"config"`.
   *
   * @default the fact is reported under an `"uncategorized"` bucket
   */
  category?: string;

  /**
   * Chronological versions of this fact. Ranges must not overlap and must be in
   * trace order. Validated at load time.
   */
  versions: TruthFactVersion[];
}

/**
 * Human-authored material knowledge requirements for a benchmark. Source
 * evidence is collected independently at each checkpoint by a source adapter.
 */
export interface TruthPackage {
  /**
   * Versioned knowledge requirements that drive coverage and maintenance.
   */
  requirements: TruthFact[];
}

/**
 * A benchmark: an evolution trace plus the Truth Package requirements it is
 * scored against, plus the source repository replayed by the first adapter.
 */
export interface LedgerBenchmark {
  /**
   * Machine name, unique per benchmark directory, used in report filenames.
   */
  name: string;

  /**
   * One-line human description of what evolution this benchmark exercises.
   */
  description: string;

  /**
   * Absolute path to the source Git repository to replay. Resolved from the
   * benchmark file location plus its declared relative or absolute repo path at
   * load time, so downstream code always sees an absolute path.
   */
  sourceRepoPath: string;

  /**
   * The frozen evolution trace.
   */
  trace: LedgerTrace;

  /**
   * The frozen human-authored Truth Package.
   */
  truthPackage: TruthPackage;
}

// ---------------------------------------------------------------------------
// Truth Package requirement projection
// ---------------------------------------------------------------------------

/**
 * A fact projected to a single checkpoint: its id, category, and the statement
 * that is true at that checkpoint. This is the unit the coverage and precision
 * passes are given.
 */
export interface ActiveTruthFact {
  /**
   * The originating fact id.
   */
  factId: string;

  /**
   * Stable id of the specific fact *version* that is active here, derived
   * deterministically as `${factId}@${fromCheckpoint}`. Two checkpoints that
   * share a version share this id; a changed fact gets a new one. Forgetting
   * targets and results identify a version by this id, not by `factId` alone.
   */
  factVersionId: string;

  /**
   * The originating fact category, defaulted to `"uncategorized"` during
   * projection so consumers never handle absence.
   */
  category: string;

  /**
   * The statement that is true at the projected checkpoint.
   */
  statement: string;
}

// ---------------------------------------------------------------------------
// Transitions between adjacent checkpoints
// ---------------------------------------------------------------------------

/**
 * A fact that became active at the current checkpoint having not been active at
 * the previous one. Its version is the one now in force.
 */
export interface IntroducedFact {
  /**
   * The logical fact id.
   */
  factId: string;

  /**
   * Stable id of the version introduced here.
   */
  factVersionId: string;

  /**
   * The statement now in force.
   */
  statement: string;
}

/**
 * A fact that was active both before and now, but whose active statement
 * changed. It carries both the obsolete previous version and the new current
 * version so correction can require the old version forgotten and the new one
 * covered.
 */
export interface ChangedFact {
  /**
   * The logical fact id.
   */
  factId: string;

  /**
   * Stable id of the previous, now-obsolete version.
   */
  previousVersionId: string;

  /**
   * The statement that was in force at the previous checkpoint and is now
   * obsolete.
   */
  previousStatement: string;

  /**
   * Stable id of the new version now in force.
   */
  currentVersionId: string;

  /**
   * The statement now in force.
   */
  currentStatement: string;
}

/**
 * A fact that was active at the previous checkpoint and is no longer active. Its
 * previous version is the forgetting target.
 */
export interface RemovedFact {
  /**
   * The logical fact id.
   */
  factId: string;

  /**
   * Stable id of the previous, now-obsolete version.
   */
  previousVersionId: string;

  /**
   * The statement that was in force at the previous checkpoint and is now
   * obsolete.
   */
  previousStatement: string;
}

/**
 * A fact whose active version is identical across the boundary.
 */
export interface StableFact {
  /**
   * The logical fact id.
   */
  factId: string;

  /**
   * Stable id of the version in force at both checkpoints.
   */
  factVersionId: string;

  /**
   * The statement in force at both checkpoints.
   */
  statement: string;
}

/**
 * How the active Truth Package requirements changed across one checkpoint
 * boundary, derived deterministically from the requirements and never from the
 * artifact. Every active fact falls into exactly one bucket.
 */
export interface CheckpointTransitions {
  /**
   * The checkpoint this transition set lands on.
   */
  checkpointId: string;

  /**
   * The checkpoint this transition set is measured from.
   */
  previousCheckpointId: string;

  /**
   * Facts newly active here.
   */
  introduced: IntroducedFact[];

  /**
   * Facts whose active statement changed here.
   */
  changed: ChangedFact[];

  /**
   * Facts that stopped being active here.
   */
  removed: RemovedFact[];

  /**
   * Facts whose active version is unchanged here.
   */
  stable: StableFact[];
}

// ---------------------------------------------------------------------------
// Immutable artifacts
// ---------------------------------------------------------------------------

/**
 * One document inside a captured wiki artifact.
 */
export interface KnowledgeDocument {
  /**
   * Path of the document relative to the wiki root, using forward slashes.
   */
  relativePath: string;

  /**
   * Full text content of the document at capture time.
   */
  content: string;
}

/**
 * An immutable snapshot of the generated wiki at one checkpoint. Once captured,
 * its document list is the evaluator's authoritative artifact input.
 */
export interface KnowledgeArtifact {
  /**
   * The checkpoint id this artifact was captured at.
   */
  checkpointId: string;

  /**
   * Absolute path to the on-disk immutable copy of the wiki for this checkpoint.
   */
  snapshotDir: string;

  /**
   * SHA-256 over the sorted document set, used to detect whether two checkpoints
   * produced identical wikis (for churn and skip handling).
   */
  fingerprint: string;

  /**
   * Every document captured, sorted by `relativePath`.
   */
  documents: KnowledgeDocument[];
}

/**
 * One stable, inspectable excerpt from the source of truth at a checkpoint.
 * Source adapters own identity and content normalization; evaluators treat the
 * resulting records as immutable evidence.
 */
export interface EvidenceRecord {
  /**
   * Stable identity unique within the checkpoint evidence corpus.
   */
  evidenceId: string;

  /**
   * Human-auditable source location such as a file path, message ID, or page ID.
   */
  sourceRef: string;

  /**
   * Checkpoint at which this source content was observed.
   */
  observedAtCheckpoint: string;

  /**
   * Whether the record belongs to the checkpoint currently being evaluated.
   */
  current: boolean;

  /**
   * Exact normalized source content available for semantic judgment.
   */
  content: string;
}

/**
 * Immutable source evidence collected for one checkpoint.
 */
export interface EvidenceCorpus {
  /**
   * Checkpoint whose source truth the records represent.
   */
  checkpointId: string;

  /**
   * Evidence records in stable identity order.
   */
  records: EvidenceRecord[];
}

// ---------------------------------------------------------------------------
// Evaluations (evaluator output, post-validation)
// ---------------------------------------------------------------------------

/**
 * Verdict for a single active fact against the wiki.
 *
 * - `correct`: the wiki states the fact accurately.
 * - `partial`: the wiki gestures at the fact but is incomplete or imprecise.
 * - `missing`: the wiki does not state the fact.
 * - `contradicted`: the wiki states something that conflicts with the fact.
 * - `indeterminate`: evaluator output remained invalid after isolated repair.
 */
export type FactVerdict =
  "correct" | "partial" | "missing" | "contradicted" | "indeterminate";

/**
 * The coverage pass's judgment about one active fact.
 */
export interface FactEvaluation {
  /**
   * The active fact this judgment concerns.
   */
  factId: string;

  /**
   * Stable id of the active fact version this judgment concerns, carried through
   * from the projected `ActiveTruthFact` for auditing and cross-checkpoint
   * matching.
   */
  factVersionId: string;

  /**
   * The verdict.
   */
  verdict: FactVerdict;

  /**
   * Stable artifact section IDs the evaluator cited as evidence.
   *
   * @default an empty array when the evaluator cited nothing (expected for a
   *   `missing` verdict)
   */
  evidence: string[];

  /**
   * One-sentence rationale, retained for auditing and report drill-down.
   */
  rationale: string;
}

/**
 * A previously true statement that may still linger in the knowledge artifact.
 * Input to the forgetting pass.
 */
export interface ObsoleteFact {
  /**
   * The statement as it appears in the wiki.
   */
  statement: string;

  /**
   * Wiki path the statement was found in, relative to the wiki root.
   */
  location: string;
}

/**
 * The forgetting pass's judgment about whether a previously-true-but-now-false
 * fact still lingers in the wiki.
 *
 * - `forgotten`: the wiki no longer asserts the obsolete statement (good).
 * - `lingering`: the wiki still asserts it (a forgetting failure).
 * - `indeterminate`: evaluator output remained invalid after isolated repair.
 */
export type ForgettingVerdict = "forgotten" | "lingering" | "indeterminate";

/**
 * A judgment about one fact that should have been forgotten (its prior version
 * is no longer active).
 */
export interface ForgettingEvaluation {
  /**
   * The originating fact id.
   */
  factId: string;

  /**
   * Stable id of the specific obsolete fact version this judgment concerns. A
   * fact can go through several obsolete versions over a trace, so the version id
   * (not `factId`) is the identity the forgetting pass reports against.
   */
  factVersionId: string;

  /**
   * The verdict.
   */
  verdict: ForgettingVerdict;

  /**
   * Stable artifact section IDs where the obsolete statement still appears.
   *
   * @default an empty array for a `forgotten` verdict
   */
  evidence: string[];

  /**
   * One-sentence rationale.
   */
  rationale: string;
}

/**
 * Precision verdict for one deduplicated material claim.
 *
 * - `supported`: the active truth ledger establishes the claim.
 * - `invented`: current truth refutes the claim and it was never true.
 * - `stale`: current truth refutes the claim but former truth established it.
 * - `unverified`: neither the truth ledger nor bounded refutation adjudicated it.
 */
export type PrecisionVerdict =
  "supported" | "invented" | "stale" | "unverified";

/** Temporal stance of an extracted material claim. */
export type PrecisionClaimTense = "current" | "historical";

/**
 * One fail-soft evaluator warning retained with a checkpoint result.
 */
export interface EvaluationWarning {
  /**
   * Semantic pass that could not repair one item.
   */
  pass: "coverage" | "forgetting" | "precision-ledger" | "precision-judgment";

  /**
   * Fact, fact-version, or assertion identity affected by the failure.
   */
  itemId: string;

  /**
   * Bounded repair-failure diagnostic safe to persist and display.
   */
  message: string;
}

/**
 * The precision pass's judgment about one material assertion in the artifact.
 * Every unique material assertion is judged; assertions are never sampled.
 */
export interface PrecisionAssertionEvaluation {
  /**
   * The material assertion as stated in the wiki.
   */
  assertion: string;

  /**
   * Artifact path the assertion was drawn from.
   */
  location: string;

  /**
   * The verdict.
   */
  verdict: PrecisionVerdict;

  /**
   * Whether the claim asserts present or explicitly historical world state.
   */
  tense: PrecisionClaimTense;

  /**
   * Truth layer responsible for the final class. Unverified claims use `none`.
   */
  adjudicatedBy: "ledger" | "source" | "none";

  /**
   * Requirement-version or source-evidence identities establishing support,
   * contradiction, or former truth. Unverified claims cite no adjudicating
   * evidence.
   */
  evidenceIds: string[];

  /**
   * One-sentence rationale.
   */
  rationale: string;
}

/**
 * The full set of evaluations for one checkpoint, produced by an
 * `EvaluationBackend`. Everything the metrics layer needs, and nothing it does
 * not.
 */
export interface CheckpointEvaluation {
  /**
   * Coverage verdicts, one per active fact at this checkpoint.
   */
  factEvaluations: FactEvaluation[];

  /**
   * Forgetting verdicts, one per fact that should have been forgotten by this
   * checkpoint.
   */
  forgettingEvaluations: ForgettingEvaluation[];

  /**
   * Precision verdicts, one per unique material assertion the wiki makes.
   */
  precisionEvaluations: PrecisionAssertionEvaluation[];

  /**
   * Items that remained invalid after isolated repair.
   *
   * @default an empty array for evaluation backends without fail-soft repair
   */
  warnings?: EvaluationWarning[];
}

/**
 * One checkpoint's coverage and forgetting verdicts paired with its id and the
 * requirement transitions it lands on. The runner accumulates one of these per
 * checkpoint, in trace order, so the trace-level diagnostics can be computed from
 * the full evaluation history. Precision verdicts are omitted because no
 * diagnostic reads them.
 */
export interface CheckpointEvaluationRecord {
  /**
   * The checkpoint these verdicts are for.
   */
  checkpointId: string;

  /**
   * Coverage verdicts at this checkpoint, one per active fact.
   */
  factEvaluations: FactEvaluation[];

  /**
   * Forgetting verdicts at this checkpoint: one per obsolete version under watch.
   * The watch set is every requirement version that is obsolete according to the
   * Truth Package here, including versions already judged `forgotten` at an
   * earlier checkpoint. Forgetting is not treated as permanent, so a forgotten
   * version stays under watch and keeps being re-evaluated as long as it remains
   * obsolete; it leaves the watch set only if the requirements make it current
   * truth again.
   */
  forgettingEvaluations: ForgettingEvaluation[];

  /**
   * The requirement transitions this checkpoint lands on, so the transition-level
   * Recovery Rate can tell which introduced, changed, and removed transitions
   * failed here and whether a later checkpoint made them good.
   *
   * @default undefined at the first checkpoint, which has no preceding boundary
   */
  transitions?: CheckpointTransitions;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Coverage at one checkpoint: the fraction of validly judged active material
 * topics the artifact states correctly. Coverage is strict — only `correct`
 * verdicts earn headline credit. The `partial`, `missing`, and `contradicted`
 * counts are diagnostic and never feed the score. Indeterminate judgments are
 * excluded and represented by Evaluator Completeness.
 */
export interface CoverageMetric {
  /**
   * Count of active material topics with a `correct` verdict.
   */
  correct: number;

  /**
   * Count of active facts with a `partial` verdict. Diagnostic only; earns no
   * headline credit.
   */
  partial: number;

  /**
   * Count of active facts with a `missing` verdict. Diagnostic only.
   */
  missing: number;

  /**
   * Count of active facts with a `contradicted` verdict. Diagnostic only.
   */
  contradicted: number;

  /**
   * Count of requirements the evaluator could not judge after isolated repair.
   */
  indeterminate: number;

  /**
   * Total active material topics evaluated.
   */
  total: number;

  /**
   * `correct / (total - indeterminate)`, or 0 when the evaluator produced no
   * valid coverage judgment. The latter is always paired with zero Evaluator
   * Completeness for this pass and must not be read as a reliable system score.
   */
  score: number;
}

/**
 * Precision at one checkpoint. Unverified claims remain visible but never enter
 * a scored denominator.
 */
export interface PrecisionMetric {
  /**
   * Count of `supported` assertions.
   */
  supported: number;

  /**
   * Claims refuted as false and never true.
   */
  invented: number;

  /**
   * Claims refuted now but established as true in a former world state.
   */
  stale: number;

  /**
   * Claims neither established nor refuted.
   */
  unverified: number;

  /**
   * Claims used by precision: `supported + invented + stale`.
   */
  adjudicated: number;

  /**
   * Total material assertions evaluated.
   */
  total: number;

  /**
   * `invented / adjudicated`, or null when no claim was adjudicated.
   */
  hallucinationRate: number | null;

  /**
   * `stale / adjudicated`, or null when no claim was adjudicated.
   */
  stalenessRate: number | null;

  /**
   * `unverified / total`, or 0 when no material claim was extracted.
   */
  unverifiedRate: number;

  /**
   * `supported / adjudicated`, or null when no claim was adjudicated.
   */
  score: number | null;
}

/**
 * Fraction of semantic evaluation items that produced valid judgments.
 */
export interface EvaluationCompletenessMetric {
  /**
   * Validly judged items across coverage, precision, and forgetting.
   */
  judged: number;

  /**
   * Items still invalid after isolated repair.
   */
  indeterminate: number;

  /**
   * Total semantic evaluation items attempted.
   */
  total: number;

  /**
   * `judged / total`, or 1 when no semantic items existed.
   */
  score: number;
}

/**
 * A raw numerator over denominator, kept unreduced so maintenance rates can be
 * summed globally across the whole trace before any single division.
 */
export interface RateCount {
  /**
   * Facts that satisfied the rate's success condition.
   */
  numerator: number;

  /**
   * Facts eligible for the rate.
   */
  denominator: number;
}

/**
 * Raw maintenance counts for one checkpoint boundary. These are unreduced tallies
 * summed across the trace before any rate is computed; there is no per-checkpoint
 * maintenance score. Transitions affected by indeterminate current judgments are
 * excluded and represented by Evaluator Completeness.
 */
export interface MaintenanceCounts {
  /**
   * New-Knowledge Discovery: of facts introduced at this checkpoint, those the
   * wiki now states correctly.
   */
  newKnowledgeDiscovery: RateCount;

  /**
   * Changed-Knowledge Correction: of facts changed at this checkpoint, those
   * whose new version is now correct AND whose previous version is forgotten.
   */
  changedKnowledgeCorrection: RateCount;

  /**
   * Complete Forgetting: of facts removed at this checkpoint, those the wiki no
   * longer asserts. A changed fact's obsolete version is counted under correction
   * only, never here, so no forgetting is double-counted.
   */
  completeForgetting: RateCount;

  /**
   * Stable-Knowledge Retention: of facts stable at this checkpoint that were
   * correct at the previous checkpoint, those still correct now.
   */
  stableRetention: RateCount;
}

/**
 * The raw per-item verdicts behind a checkpoint's scores, retained so a score is
 * explainable. The scores above are lossy reductions of these lists to counts;
 * these are the lists themselves, exactly as the evaluator returned them, so a
 * reader can see which requirements were missed, which assertions source
 * evidence supported or rejected, and which obsolete
 * versions the artifact dropped.
 */
export interface CheckpointEvaluationDetail {
  /**
   * Coverage verdicts, one per active fact at this checkpoint.
   */
  factEvaluations: FactEvaluation[];

  /**
   * Precision verdicts, one per unique material assertion the wiki makes.
   */
  precisionEvaluations: PrecisionAssertionEvaluation[];

  /**
   * Forgetting verdicts, one per obsolete version under watch at this checkpoint.
   * Empty at checkpoints where no version is obsolete, which is why a trace with
   * no changed or removed facts shows nothing about forgetting.
   */
  forgettingEvaluations: ForgettingEvaluation[];

  /**
   * Fail-soft item repair failures retained for audit.
   *
   * @default an empty array for older or synthetic results
   */
  warnings?: EvaluationWarning[];
}

/**
 * The scored result for one checkpoint. Quality and maintenance are not scored
 * per checkpoint; only the raw components that aggregate to the trace level are
 * kept here.
 */
export interface CheckpointScore {
  /**
   * The checkpoint id.
   */
  checkpointId: string;

  /**
   * Coverage at this checkpoint.
   */
  coverage: CoverageMetric;

  /**
   * Precision at this checkpoint.
   */
  precision: PrecisionMetric;

  /**
   * Evaluator reliability for this checkpoint, separate from system quality.
   */
  evaluationCompleteness: EvaluationCompletenessMetric;

  /**
   * Raw maintenance counts for the boundary into this checkpoint. Absent at the
   * first checkpoint, which has no prior state to maintain.
   *
   * @default absent at index 0, where there is no prior state to maintain
   */
  maintenanceCounts?: MaintenanceCounts;

  /**
   * Efficiency observations for the run that produced this checkpoint.
   */
  efficiency: LedgerExecutionMetrics;

  /**
   * The raw per-item verdicts behind this checkpoint's scores, retained for
   * auditing and report drill-down.
   *
   * @default absent on synthetic scores built by hand (in tests); the runner
   *   always populates it from the evaluator's output
   */
  evaluations?: CheckpointEvaluationDetail;
}

/**
 * The four trace-level maintenance rates, each computed by summing raw numerators
 * and denominators across the whole trace and dividing once. A rate whose global
 * denominator is 0 never occurred on the trace and is left `undefined` rather
 * than credited; such a rate is excluded from the Maintenance Score.
 */
export interface MaintenanceRates {
  /**
   * Trace New-Knowledge Discovery.
   *
   * @default undefined when no fact was introduced anywhere on the trace
   */
  newKnowledgeDiscovery?: number;

  /**
   * Trace Changed-Knowledge Correction.
   *
   * @default undefined when no fact changed anywhere on the trace
   */
  changedKnowledgeCorrection?: number;

  /**
   * Trace Complete Forgetting.
   *
   * @default undefined when no fact was removed anywhere on the trace
   */
  completeForgetting?: number;

  /**
   * Trace Stable-Knowledge Retention.
   *
   * @default undefined when no eligible stable fact existed anywhere on the trace
   */
  stableRetention?: number;
}

/**
 * The final aggregated LEDGER score for a whole run. Quality aggregates as
 * checkpoint macro-averages; maintenance aggregates from global raw counts.
 */
export interface LedgerScore {
  /**
   * Macro-average of per-checkpoint `coverage.score` across the trace, 0 to 1.
   */
  traceCoverage: number;

  /**
   * Macro-average of defined per-checkpoint `precision.score` values. Null when
   * no checkpoint contains an adjudicated precision claim.
   */
  tracePrecision: number | null;

  /** Macro-average assertion hallucination rate over defined checkpoints. */
  traceHallucinationRate: number | null;

  /** Macro-average assertion staleness rate over defined checkpoints. */
  traceStalenessRate: number | null;

  /** Macro-average unverified-claim rate across all checkpoints. */
  traceUnverifiedRate: number;

  /**
   * Micro-average of valid evaluator judgments across every checkpoint. This is
   * evaluator reliability metadata and does not feed Quality or the LEDGER Score.
   */
  evaluationCompleteness: number;

  /**
   * Harmonic mean of trace coverage and precision. Null when trace precision is
   * null.
   */
  quality: number | null;

  /**
   * The four trace-level maintenance rates. Rates whose global denominator was 0
   * are `undefined`.
   */
  maintenanceRates: MaintenanceRates;

  /**
   * Mean of the defined trace-level maintenance rates, 0 to 1. Absent when no
   * maintenance dimension occurred anywhere on the trace (a single-checkpoint
   * trace, for instance).
   *
   * @default absent when no maintenance dimension occurred on the trace
   */
  maintenance?: number;

  /**
   * `(quality + maintenance) / 2` when maintenance is defined, otherwise
   * `quality`. Reported to the user as 0 to 100.
   */
  ledgerScore: number | null;
}

/**
 * Trace-level diagnostics computed from the full evaluation history. These
 * describe qualitative behavior over the trace and are reported alongside the LEDGER
 * Score, but they are deliberately not part of the Maintenance Score or the LEDGER
 * Score.
 */
export interface LedgerDiagnostics {
  /**
   * Recovery Rate: of the maintenance transitions that failed at their own
   * boundary, the fraction a later checkpoint made good. Eligibility and recovery
   * are judged per transition type, mirroring the maintenance success conditions:
   * an introduced fact recovers when the current fact later reads `correct`; a
   * changed fact recovers when the new version reads `correct` and the obsolete
   * version is forgotten; a removed fact recovers when the obsolete version is
   * forgotten. Stable-retention regressions are excluded in V1. A measure of how
   * well the system self-heals maintenance it initially got wrong, in [0, 1].
   *
   * @default undefined when no introduced, changed, or removed transition failed
   *   at its boundary, so nothing was eligible to recover
   */
  recoveryRate?: number;

  /**
   * Stale-Knowledge Lifetime: how long obsolete fact versions kept lingering in
   * the wiki after they became obsolete, before each was first judged forgotten.
   * Preserved per obsolete version, so a version not yet forgotten when
   * observation stopped is kept as an unresolved record rather than being counted
   * as forgotten at an assumed lifetime.
   */
  staleKnowledge: StaleKnowledgeDiagnostic;
}

/**
 * The Stale-Knowledge Lifetime diagnostic: one record per obsolete fact version
 * plus a summary. The mean is taken over resolved (eventually forgotten) versions
 * only; unresolved obsolete versions (those never judged forgotten before
 * observation stopped) are counted separately and never folded into the mean as
 * if their final lifetime were known.
 */
export interface StaleKnowledgeDiagnostic {
  /**
   * One record per obsolete fact version, in first-seen trace order.
   */
  records: StaleKnowledgeRecord[];

  /**
   * The mean lingering lifetime, in checkpoints, over resolved versions only.
   *
   * @default undefined when no obsolete version was ever forgotten on the trace
   */
  meanResolvedLifetime?: number;

  /**
   * How many obsolete versions were left unresolved (never judged forgotten) when
   * observation stopped. These are preserved in `records` but excluded from
   * `meanResolvedLifetime`.
   */
  unresolvedCount: number;
}

/**
 * The stale lifetime of a single obsolete fact version.
 */
export interface StaleKnowledgeRecord {
  /**
   * The obsolete fact version this record tracks.
   */
  factVersionId: string;

  /**
   * How many checkpoints the version was judged `lingering` before it was first
   * judged `forgotten` — its stale lifetime. For a resolved version this is its
   * final lifetime; for an unresolved one it is a lower bound, since the version
   * might have lingered longer had the trace continued. Lingering verdicts after a
   * first forgetting (an obsolete version that recurs) are not counted here; V1
   * leaves such recurrences in the raw forgetting history without a separate
   * metric.
   */
  lingeredCheckpoints: number;

  /**
   * Whether the version was ever judged `forgotten` on the trace. When false the
   * version was never forgotten before observation stopped (it was revived, or the
   * trace ended), so its true lifetime is unknown.
   */
  resolved: boolean;
}

// ---------------------------------------------------------------------------
// Efficiency
// ---------------------------------------------------------------------------

/**
 * Diagnostic efficiency observations for a single SUT run. None of these feed
 * the LEDGER Score; they are reported alongside it.
 */
export interface LedgerExecutionMetrics {
  /**
   * Wall-clock milliseconds the SUT spent on this checkpoint's run.
   */
  durationMs: number;

  /**
   * Whether the SUT reported the run as a no-op (an `update` with no source
   * change). When true the prior artifact is carried forward.
   */
  skipped: boolean;

  /**
   * Lines added plus removed between the previous artifact and this one, from a
   * deterministic diff. Absent at the first checkpoint.
   *
   * @default absent at index 0, where there is no prior artifact to diff against
   */
  churnedLines?: number;

  /**
   * Total tokens the run consumed, when token capture is enabled (Phase 8).
   *
   * @default absent unless the optional usage callback is wired in
   */
  totalTokens?: number;

  /**
   * Estimated cost in US dollars, when token capture and pricing are enabled.
   *
   * @default absent unless token capture and a price table are provided
   */
  estimatedCostUsd?: number;
}

// ---------------------------------------------------------------------------
// Run configuration and results
// ---------------------------------------------------------------------------

/**
 * Everything a single LEDGER run needs, resolved from environment and CLI args.
 */
export interface LedgerRunConfig {
  /**
   * Absolute path to the benchmark directory (the folder containing
   * `benchmark.json`).
   */
  benchmarkDir: string;

  /**
   * Provider id passed through to OpenWiki via the environment, for example
   * `"anthropic"`.
   */
  provider: string;

  /**
   * Model id for the System Under Test, or undefined to let OpenWiki resolve its
   * default.
   *
   * @default OpenWiki's own default model for the provider
   */
  systemModelId?: string;

  /**
   * Model id for the evaluator agent.
   *
   * @default falls back to `systemModelId`, then to the evaluator's own default
   */
  evaluatorModelId?: string;

  /**
   * Absolute path to the directory run outputs are written under. LEDGER creates a
   * timestamped subdirectory beneath it.
   */
  resultsDir: string;
}

/**
 * Metadata describing one completed run, written alongside its results.
 */
export interface LedgerRunMetadata {
  /**
   * The benchmark name that was run.
   */
  benchmarkName: string;

  /**
   * ISO-8601 timestamp the run started, stamped by the caller (scripts cannot
   * read the clock deterministically, so this is injected).
   */
  startedAt: string;

  /**
   * Provider and model the SUT used.
   */
  system: { provider: string; modelId?: string };

  /**
   * Model the evaluator used.
   */
  evaluatorModelId?: string;

  /**
   * Absolute path of the completed run whose immutable artifacts and source
   * evidence were reused for evaluator-only replay.
   *
   * @default absent for a normal end-to-end benchmark run
   */
  reevaluatedFrom?: string;
}

/**
 * The complete result of a LEDGER run: per-checkpoint scores plus the aggregate.
 */
export interface LedgerRunResult {
  /**
   * Run metadata.
   */
  metadata: LedgerRunMetadata;

  /**
   * One entry per checkpoint, in trace order.
   */
  checkpoints: CheckpointScore[];

  /**
   * The aggregated score.
   */
  score: LedgerScore;

  /**
   * Trace-level diagnostics, reported alongside the score but not part of it.
   */
  diagnostics: LedgerDiagnostics;
}

// ---------------------------------------------------------------------------
// Extension contracts (the seam described in Section 0.4)
// ---------------------------------------------------------------------------

/**
 * The outcome of asking a System Under Test to run at one checkpoint.
 */
export interface SystemRunOutcome {
  /**
   * Whether the system reported the run as a no-op.
   */
  skipped: boolean;

  /**
   * Wall-clock milliseconds the run took.
   */
  durationMs: number;

  /**
   * Total tokens consumed, if the system can report them.
   *
   * @default absent when the system does not report token usage
   */
  totalTokens?: number;
}

/**
 * A documentation system LEDGER can benchmark. Today this is OpenWiki
 * (`openwiki-system.ts`); later a Grounded Claims build implements the same
 * interface and runs the identical benchmark.
 */
export interface SystemUnderTest {
  /**
   * Stable name for reports, for example `"openwiki-baseline"`.
   */
  readonly name: string;

  /**
   * Run the system's initial generation against a prepared worktree, writing its
   * wiki into `<worktreeDir>/openwiki/`.
   *
   * @param worktreeDir - Absolute path to the checked-out worktree at T0.
   *
   * @returns The run outcome.
   */
  init(worktreeDir: string): Promise<SystemRunOutcome>;

  /**
   * Run the system's incremental update against a prepared worktree whose source
   * has advanced to a later checkpoint and whose `openwiki/` still holds the
   * prior artifact.
   *
   * @param worktreeDir - Absolute path to the checked-out worktree at Tn.
   *
   * @returns The run outcome.
   */
  update(worktreeDir: string): Promise<SystemRunOutcome>;
}

/**
 * Turns an immutable artifact, active requirements, and source evidence into the
 * three evaluation passes. Production and deterministic test implementations
 * satisfy this contract.
 */
export interface EvaluationBackend {
  /**
   * Evaluate one checkpoint's artifact.
   *
   * @param input - The artifact, requirements, and evidence needed to score it.
   *
   * @returns The three evaluation passes for this checkpoint.
   */
  evaluate(input: EvaluationInput): Promise<CheckpointEvaluation>;
}

/**
 * Everything an `EvaluationBackend` needs to score one checkpoint.
 */
export interface EvaluationInput {
  /**
   * The immutable artifact captured after this checkpoint's run.
   */
  artifact: KnowledgeArtifact;

  /**
   * Material knowledge requirements active at this checkpoint.
   */
  activeFacts: ActiveTruthFact[];

  /**
   * Current normalized source evidence used to verify artifact assertions.
   */
  evidence: EvidenceCorpus;

  /**
   * Fact versions that went obsolete at the transition into this checkpoint and
   * must no longer linger (forgetting targets). Empty at the first checkpoint.
   */
  obsoleteFacts: ObsoleteFactTarget[];
}

/**
 * A fact that should have been forgotten by the current checkpoint: its now-false
 * prior statement, which the wiki should no longer assert.
 */
export interface ObsoleteFactTarget {
  /**
   * The originating fact id.
   */
  factId: string;

  /**
   * Stable id of the specific version that went obsolete, so the forgetting pass
   * identifies the exact prior version rather than the logical fact.
   */
  factVersionId: string;

  /**
   * The statement that used to be true and is now obsolete.
   */
  obsoleteStatement: string;
}
