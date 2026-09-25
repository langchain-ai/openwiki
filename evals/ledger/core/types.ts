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
   * Stable identifier used to reference this checkpoint (for example `"T0"`,
   * `"T3"`). Unique within a benchmark.
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
 * One evaluator-only route from a natural-language topic to source locations
 * capable of establishing or refuting claims about that topic. The concept is
 * deliberately not a statement of expected truth; raw source remains the only
 * grounding authority.
 */
export interface SemanticEvidenceMapEntry {
  /** Stable benchmark-local route identifier retained in audit output. */
  id: string;

  /** Natural-language topic description used only for lexical routing. */
  concept: string;

  /**
   * Relative source paths, `path#symbol` selectors, or path globs. V1 resolves
   * a symbol selector to its complete owning file so the judge sees context.
   */
  evidence: string[];
}

/**
 * Reviewed evaluator-only routing metadata supplied by a benchmark. It helps
 * translate wiki prose into likely source locations without encoding answers.
 */
export interface SemanticEvidenceMap {
  /** Topic-to-source routes available across the benchmark's full trace. */
  entries: SemanticEvidenceMapEntry[];
}

/**
 * A benchmark: an evolution trace plus the source repository it is scored
 * against. Truth is read directly from the source at each checkpoint by
 * `extractSurface`; there is no hand-authored knowledge census.
 */
/**
 * Author-declared honest rating of how hard a benchmark's history is for a
 * documentation system to maintain. Rendered in the run headline and report so
 * weak results on a `hard` benchmark read differently from the same results on
 * an `easy` benchmark. Declared by a human, never computed from the trace.
 */
export type BenchmarkDifficulty = "easy" | "medium" | "hard";

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
   * Author-declared difficulty of maintaining documentation across this
   * benchmark's history.
   */
  difficulty: BenchmarkDifficulty;

  /**
   * Absolute path to the source Git repository to replay. Resolved from the
   * benchmark file location plus its declared relative or absolute repo path at
   * load time, so downstream code always sees an absolute path.
   */
  sourceRepoPath: string;

  /**
   * Optional evaluator-only semantic routing map. It is never exposed to the
   * System Under Test. Benchmarks without one retain source BM25 selection.
   */
  evidenceMap?: SemanticEvidenceMap;

  /**
   * The frozen evolution trace.
   */
  trace: LedgerTrace;
}

// ---------------------------------------------------------------------------
// Source surface
// ---------------------------------------------------------------------------

/**
 * The kind of public-surface element a `SurfaceItem` describes.
 */
export type SurfaceKind = "symbol" | "file" | "version";

/**
 * One element of a repository's public surface at a single checkpoint,
 * extracted deterministically from source by `extractSurface` (no human
 * authoring). A surface element whose `statement` changes or disappears across
 * a boundary becomes a forgetting watch target, so the field names deliberately
 * mirror `ObsoleteFactTarget` (`factId`, `factVersionId`, `statement`) that the
 * evaluator consumes.
 */
export interface SurfaceItem {
  /**
   * Stable logical id for this surface element, unique within a checkpoint:
   * `symbol:<name>`, `file:<path>`, or `version`. Forgetting history keys off
   * this id across checkpoints.
   */
  factId: string;

  /**
   * Content-addressed version id, `${factId}@${shortHash(statement)}`. Stable
   * across checkpoints while the element is unchanged and fresh when its
   * `statement` changes, so a changed element retires its prior version into the
   * forgetting watch set and a byte-identical revival reuses the same id.
   */
  factVersionId: string;

  /**
   * The surface element's kind.
   */
  kind: SurfaceKind;

  /**
   * Human-readable name: the exported symbol name, the file path, or the version
   * string.
   */
  name: string;

  /**
   * For a `symbol`, its reconstructed one-line signature.
   *
   * @default absent for `file` and `version` items, which have no signature
   */
  signature?: string;

  /**
   * A self-contained claim describing this surface element. When the element
   * goes obsolete, this becomes the forgetting target's `obsoleteStatement`.
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
 * version so the old version can be tracked until it is forgotten.
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
 * How the source surface changed across one checkpoint boundary, derived
 * deterministically by `diffSurface` from the two checkpoints' surfaces and
 * never from the artifact. Every surface element present at either checkpoint
 * falls into exactly one bucket.
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
   * Exact verbatim artifact text that demonstrates the obsolete version is
   * still presented as current. Present only for a `lingering` verdict and
   * validated against one of the cited sections.
   */
  matchedText?: string;

  /**
   * One-sentence rationale.
   */
  rationale: string;
}

/**
 * Precision verdict for one deduplicated material claim.
 *
 * - `supported`: the source evidence establishes the claim.
 * - `invented`: current source refutes the claim and it was never true.
 * - `stale`: current source refutes the claim but earlier source established it.
 * - `unverified`: the source evidence neither confirmed nor refuted the claim.
 */
export type PrecisionVerdict =
  "supported" | "invented" | "stale" | "unverified";

/**
 * Temporal stance of an extracted material claim.
 */
export type PrecisionClaimTense = "current" | "historical";

/**
 * One fail-soft evaluator warning retained with a checkpoint result.
 */
export interface EvaluationWarning {
  /**
   * Semantic pass that could not repair one item.
   */
  pass: "forgetting" | "precision-extraction" | "precision-judgment";

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
   * Exact artifact text from which the normalized assertion was extracted.
   * Older persisted runs may omit this field.
   */
  sourceQuote?: string;

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
 * One checkpoint's forgetting verdicts. The runner accumulates these in trace
 * order to compute stale-knowledge lifetime.
 */
export interface CheckpointEvaluationRecord {
  /**
   * Forgetting verdicts at this checkpoint: one per obsolete version under watch.
   * The watch set is every surface version that is obsolete according to the
   * source diff here, including versions already judged `forgotten` at an
   * earlier checkpoint. Forgetting is not treated as permanent, so a forgotten
   * version stays under watch and keeps being re-evaluated as long as it remains
   * obsolete; it leaves the watch set only if the source surface makes it current
   * truth again.
   */
  forgettingEvaluations: ForgettingEvaluation[];
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Snapshot-wide state of current factual claims at one checkpoint. Every rate
 * uses `total` so the four states form a complete partition.
 */
export interface ClaimStateMetric {
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
   * Total current-tense material assertions evaluated. Historical narration is
   * audited in the raw evaluations but excluded from this snapshot metric.
   */
  total: number;

  /**
   * `invented / total`, or 0 when no current claim was extracted.
   */
  hallucinationRate: number;

  /**
   * `stale / total`, or 0 when no current claim was extracted.
   */
  stalenessRate: number;

  /**
   * `unverified / total`, or 0 when no material claim was extracted.
   */
  unverifiedRate: number;

  /**
   * `supported / total`, or 0 when no current claim was extracted.
   */
  supportedRate: number;
}

/**
 * Fraction of semantic evaluation items that produced valid judgments.
 */
export interface EvaluationCompletenessMetric {
  /**
   * Validly judged items across claim grounding and forgetting.
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
  rate: number;
}

/**
 * The raw per-item verdicts behind a checkpoint's measurements. The claim-state
 * rates are lossy reductions of these lists to counts. These are the lists
 * themselves, exactly as the evaluator returned them, so a reader can inspect
 * source-grounding and obsolete-version judgments.
 */
export interface CheckpointEvaluationDetail {
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
 * The measured result for one checkpoint.
 */
export interface CheckpointResult {
  /**
   * The checkpoint id.
   */
  checkpointId: string;

  /**
   * Snapshot-wide state of the wiki's current factual claims.
   */
  claims: ClaimStateMetric;

  /**
   * Evaluator reliability for this checkpoint, separate from system quality.
   */
  evaluationCompleteness: EvaluationCompletenessMetric;

  /**
   * Efficiency observations for the run that produced this checkpoint.
   */
  efficiency: LedgerExecutionMetrics;

  /**
   * The raw per-item verdicts behind this checkpoint's measurements, retained for
   * auditing and report drill-down.
   *
   * @default absent on synthetic results built by hand (in tests); the runner
   *   always populates it from the evaluator's output
   */
  evaluations?: CheckpointEvaluationDetail;
}

/**
 * Trace-level forgetting diagnostics computed from the evaluation history.
 */
export interface LedgerDiagnostics {
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
   * judged `forgotten`, its stale lifetime. For a resolved version this is its
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
 * Diagnostic efficiency observations for a single SUT run.
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
   * Author-declared difficulty of the benchmark that was run.
   */
  difficulty: BenchmarkDifficulty;

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
 * The complete result of a LEDGER run: per-checkpoint claim state plus
 * trace-level diagnostics.
 */
export interface LedgerRunResult {
  /**
   * Run metadata.
   */
  metadata: LedgerRunMetadata;

  /**
   * One entry per checkpoint, in trace order.
   */
  checkpoints: CheckpointResult[];

  /** Run-level score derived from claim health. */
  score: LedgerScore;

  /**
   * Trace-level forgetting diagnostics.
   */
  diagnostics: LedgerDiagnostics;
}

/** Auditable components of the run-level LEDGER score. */
export interface LedgerScore {
  /** Opportunity-weighted claim health across every checkpoint. */
  value: number;

  /** Supported current claims divided by all current claims across checkpoints. */
  claimHealth: number;
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
 * Turns an immutable artifact and source evidence into claim-grounding and
 * forgetting judgments. Production and deterministic test implementations
 * satisfy this contract.
 */
export interface EvaluationBackend {
  /**
   * Evaluate one checkpoint's artifact.
   *
   * @param input - The artifact, obsolete watchlist, and grounding evidence.
   *
   * @returns Claim-grounding and forgetting judgments for this checkpoint.
   */
  evaluate(
    input: EvaluationInput,
    observer?: EvaluationProgressObserver,
  ): Promise<CheckpointEvaluation>;
}

/**
 * Optional lifecycle observations emitted while one checkpoint is evaluated.
 */
export interface EvaluationProgressObserver {
  /**
   * Report completed text-unit extraction work.
   */
  onClaimExtractionProgress?(completed: number, total: number): void;

  /**
   * Report completed post-extraction judgments. The claim count is the distinct
   * current-tense snapshot denominator; progress includes both claim grounding
   * and obsolete-fact judgments so 100% means checkpoint evaluation is done.
   */
  onClaimEvaluationProgress?(
    claimCount: number,
    completed: number,
    total: number,
  ): void;
}

/**
 * Everything an `EvaluationBackend` needs to evaluate one checkpoint.
 */
export interface EvaluationInput {
  /**
   * The immutable artifact captured after this checkpoint's run.
   */
  artifact: KnowledgeArtifact;

  /**
   * Current normalized source evidence used to verify artifact assertions.
   */
  evidence: EvidenceCorpus;

  /**
   * Optional evaluator-only topic-to-source routing metadata for this
   * benchmark. Raw source selected through the map remains the grounding truth.
   */
  evidenceMap?: SemanticEvidenceMap;

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
