# LEDGER 🧪

LEDGER (Longitudinal Evaluation of Documentation Grounding, Evolution, and
Revision) is a source-grounded framework for evaluating whether generated
knowledge artifacts remain accurate and current as their underlying source of
truth evolves. The current adapter replays Git checkpoints, runs OpenWiki, and
evaluates each frozen wiki snapshot.

LEDGER reports the state of every current factual claim in the wiki.

## Claim state

At each checkpoint the evaluator reads every generated Markdown document, splits
it into text units, and extracts atomic factual claims. Navigation, opinions,
instructions, wiki self-description, and other non-factual material produce no
claims. Explicit historical narration remains in the audit record but is excluded
from the headline snapshot metric.

Each current-tense claim ends in exactly one state:

| State        | Meaning                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `supported`  | Current source evidence establishes the claim.                                                                       |
| `stale`      | Current source contradicts the claim and historical source establishes that it was formerly true.                    |
| `invented`   | Current source contradicts the claim and historical source does not establish it. The CLI calls this `hallucinated`. |
| `unverified` | The supplied evidence neither establishes nor contradicts the claim.                                                 |

All four rates use the same denominator:

```text
current claims = supported + stale + invented + unverified

supported rate     = supported / current claims
staleness rate     = stale / current claims
hallucination rate = invented / current claims
unverified rate    = unverified / current claims
```

Each checkpoint recomputes this partition from the entire current wiki; it is not
a delta or an average of earlier checkpoints. When at least one current claim
exists, the unrounded rates sum to 100% (whole-number CLI rounding may not). A
claim-free wiki reports zero for all four rates. `Unverified` is not treated as a
factual error; it is the audit worklist and confidence boundary around the known
results.

### Claim evaluation pipeline

```text
all generated Markdown
        │
        ▼
classify every text unit and extract atomic claims with exact artifact quotes
        │
        ▼
remove normalized exact duplicates
        │
        ▼
match claim prose to evaluator-only evidence-map concepts
        │
        ▼
resolve mapped paths/symbols/globs to raw source and add bounded fallback evidence
        │
        ▼
supported / contradicted / not addressed
        │
        ├ contradicted → check distinct historical evidence
        │                  ├ formerly true → stale
        │                  └ not established → invented
        └ not addressed → unverified
```

Source evidence contains a tracked-file manifest plus bounded text chunks from
every tracked, regular, non-binary Git file except the generated `openwiki/`
artifact. Symlinks are skipped. Current evidence comes from the active
checkpoint; evidence captured at every earlier checkpoint is marked historical.

Benchmarks may also provide a reviewed semantic evidence map. Each entry names a
natural-language topic and the source locations capable of establishing or
refuting claims about that topic:

```json
{
  "id": "queue-ordering",
  "concept": "task queue insertion, ordering, and removal behavior",
  "evidence": [
    "src/queue.ts#enqueue",
    "src/queue.ts#dequeue",
    "src/worker.ts#runWorker"
  ]
}
```

The map is evaluator-only routing metadata, never input to OpenWiki and never a
statement of expected truth. BM25 matches wiki prose to the map's prose concepts,
where lexical retrieval is appropriate; selectors then resolve deterministically
to raw source. V1 supplies the complete owning file for `path#symbol` selectors
so the judge sees surrounding context. Exact paths and path globs are also
supported. A coding agent can draft the map from the benchmark trace, followed by
a quick review that concepts describe topics and locations rather than expected
answers.

Current claims are grounded against current evidence first; historical snapshots
cannot crowd current truth out of the retrieval window. A named source path is
always included, routed evidence-map files are mandatory, and a claim naming a
missing file receives the complete tracked-file manifest. Small corpora are
supplied in full. Larger corpora retain mandatory routed evidence and use direct
source BM25 to fill a minimum eight-excerpt candidate set within a soft character
budget. A claim that matches no map entry therefore retains the prior exhaustive-
when-small and bounded-BM25-when-large behavior. Byte-identical historical
excerpts are deduplicated, and historical evidence is consulted only after
current source establishes a contradiction. Every matched route ID, selector,
resolved source path, selected evidence identity, cache hit, and historical
follow-up is preserved in the assertion inventory. Routing is deterministic and
adds no evaluator model calls.

## Benchmark contract

A benchmark contains a source-of-truth Git history, an ordered set of pinned
checkpoints, an author-declared difficulty, and optionally a reviewed semantic
evidence map. The checked-in calc and taskflow benchmarks both include maps.

Map concepts should identify a fact category, never supply its conclusion. For
example, use `task queue insertion, ordering, and removal behavior`, not `tasks
are removed FIFO`. Include every source location capable of supporting or
refuting that category. Selectors may refer to symbols that exist only at some
checkpoints; unresolved selectors are ignored at checkpoints where that source
is absent. Multiple matched entries are unioned before grounding.

Each normalized claim retains an exact contiguous quote plus its complete
artifact text unit, path, and heading context. Grounding checks that provenance
before judging source truth, so a dropped qualifier, broadened table row,
misread conceptual diagram, or historical passage mislabeled as current becomes
`unverified` instead of a false stale or hallucinated result. Non-verbatim
extractor quotes are rejected and repaired before grounding.

Evaluator failures do not abort the run. A claim-grounding judgment that remains
invalid after isolated repair falls back to `unverified`; a failed extraction
unit contributes no claims. Both cases lower the separately reported evaluator
completeness rate and remain visible as warnings in the audit report.

## LEDGER score

The run-level score is opportunity-weighted claim health across the trace:

```text
claim health = supported current claims / all current claims across checkpoints
LEDGER score = claim health
```

Stale, hallucinated, and unverified claims all lower claim health because they
remain in its denominator. The score does not measure whether the wiki covers
every important source topic; that limitation remains explicit.

## CLI output

```text
┌ 🧪 LEDGER · taskflow · hard
│ 5 checkpoints · anthropic · system claude-opus-4-8 · evaluator claude-opus-4-8
│ 📦 Replay workspace ready
│
├ 📍 1/5 · T0 · 3f2a1b9 · baseline API
│ 🤖 OpenWiki init complete · 5.4s · 12 documents
│ 📊 35 claims
│    supported 91% (32) · stale 0% (0) · hallucinated 3% (1) · unverified 6% (2)
│
├ 📍 2/5 · T1 · a7c40e2 · RedisStore + retry API
│ 🤖 OpenWiki update complete · 6.8s · 14 documents
│ 📊 50 claims
│    supported 88% (44) · stale 4% (2) · hallucinated 2% (1) · unverified 6% (3)
│
├ 🔬 Details → evals/ledger/.results/taskflow-…/report.md
└ ✅ LEDGER score 89% · 2m 11s
```

The displayed claim count is the shared snapshot denominator: distinct current-
tense claims after exact deduplication. Individual claims, citations, evaluator
warnings, and stale lifetimes are kept in `report.md`, `result.json`, the
assertion inventories, evidence snapshots, and, when current unverified claims
exist, `unverified-claims.md`.

Pass `--verbose` to print every stale and hallucinated claim beneath the
checkpoint that produced it. The default output retains only percentages and
counts. A nonzero rate below one percent is displayed as `<1%` rather than being
rounded down to `0%`.

While evaluation is active, the spinner reports phase-specific completion:

```text
│ ⠼ 🔍 Extracting claims · 44%
│ ⠼ 🔍 Grounding 35 claims · 49%
```

Extraction advances by classified text units. After extraction, grounding
progress advances through distinct-claim judgments, so 100% means the checkpoint
evaluation is genuinely complete.

## Running

```bash
OPENWIKI_PROVIDER=anthropic \
LEDGER_EVALUATOR_MODEL_ID=claude-sonnet-5 \
pnpm run eval:ledger -- --benchmark evals/ledger/benchmarks/taskflow
```

Provider credentials use the same environment configuration as OpenWiki. Add
`--system-model <id>` or `--evaluator-model <id>` to override either model, and
`--verbose` to print every stale and hallucinated claim.

Re-evaluate a completed run without invoking OpenWiki again:

```bash
OPENWIKI_PROVIDER=anthropic \
LEDGER_EVALUATOR_MODEL_ID=claude-sonnet-5 \
pnpm run eval:ledger:reevaluate -- \
  --benchmark evals/ledger/benchmarks/taskflow \
  --run evals/ledger/.results/taskflow-<timestamp>
```

Useful validation commands:

```bash
pnpm run eval:ledger:typecheck
pnpm exec vitest run evals/ledger
```

Live evaluator calibration is opt-in through `LEDGER_LIVE=1`. The normal suite is
offline and substitutes deterministic evaluator and system implementations.
