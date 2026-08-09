# KEB: Knowledge Evolution Benchmark

KEB measures how well a documentation system keeps a wiki accurate as source code
evolves. It replays a frozen sequence of commits, runs the system's `init` then
`update` at each checkpoint, freezes the generated wiki, and scores it against a
hand-authored Truth Ledger.

## Score

- **KEB Score** = (Quality + Maintenance) / 2, reported 0 to 100. When a trace
  has no checkpoint boundary to maintain (a single checkpoint), Maintenance is
  undefined and the KEB Score is Quality alone.
- **Quality** = harmonic mean of trace Coverage and trace Precision, where each
  is the macro-average of its per-checkpoint scores. The harmonic mean is taken
  once at the trace level, not per checkpoint.
  - **Knowledge Coverage** is strict: `correct / total` active facts. Partial,
    missing, and contradicted verdicts earn no headline credit and are
    diagnostic only.
  - **Factual Precision** = `supported / total` unique material assertions the
    wiki makes, judged against the active Truth Ledger only, never against the
    source code, and never by asking whether the wiki substantiates itself.
    Every assertion is evaluated with no sampling. A wiki that makes no material
    assertions scores 0, not 1.
- **Maintenance** = mean of the four trace-level rates below. Each rate is
  computed once, by summing its raw numerators and denominators across the whole
  trace and dividing a single time, not by averaging per-checkpoint
  percentages. A rate whose global denominator is 0 never occurred on the trace
  and is omitted from the mean rather than counted as 0.
  - **New-Knowledge Discovery**: of facts introduced at a boundary, those now
    stated correctly.
  - **Changed-Knowledge Correction**: of facts changed at a boundary, those
    whose new version is correct AND whose previous version is forgotten.
  - **Complete Forgetting**: of facts removed at a boundary, those the wiki no
    longer asserts.
  - **Stable Retention**: of stable facts that were correct at the previous
    checkpoint, those still correct now.
- **Efficiency** (latency and churn; tokens and cost are optional and off by
  default in V1) is reported but never folded into the KEB Score.
- **Diagnostics** are reported beside the score and, like Efficiency, never
  folded into it:
  - **Recovery Rate**: of the introduced, changed, and removed transitions that
    failed at their boundary, the fraction a later checkpoint made good (an
    introduced fact read `correct` later; a changed fact's new version `correct`
    with the obsolete version forgotten; a removed fact's obsolete version
    forgotten). Stable-retention regressions are excluded in V1. A measure of
    self-healing.
  - **Stale-Knowledge Lifetime**: how long each obsolete fact version lingered
    before it was forgotten, kept per version. The report shows the mean over
    resolved versions; unresolved obsolete versions are counted separately, never
    folded into the mean as if their lifetime were known.

## Run

    export OPENWIKI_PROVIDER=anthropic
    export ANTHROPIC_API_KEY=sk-ant-...
    export OPENWIKI_MODEL_ID=claude-sonnet-5          # system under test
    export KEB_EVALUATOR_MODEL_ID=claude-sonnet-5     # evaluator

    pnpm exec tsx evals/keb/run.ts --benchmark evals/keb/benchmarks/example

Results (a `result.json` and `report.md`) are written under
`evals/keb/.results/`.

## Author a benchmark

See section 7.6 of `misc/keb-implementation-phased-guide.md`. In short: point
`sourceRepo` at a real checkout, list real commits as checkpoints, and hand-author
the Truth Ledger of facts with their valid checkpoint ranges. Every checkpoint
must have at least one active fact, or the benchmark is rejected as invalid when
it loads.

## Tests

    pnpm exec vitest run evals/keb           # offline: deterministic core
    KEB_LIVE=1 pnpm exec vitest run evals/keb # adds live agent tests (needs credentials)
    pnpm run eval:keb:typecheck
