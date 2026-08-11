# LEDGER 🧪

LEDGER measures whether an evolving knowledge artifact remains grounded as its
source changes. The current adapter replays Git checkpoints, runs OpenWiki, and
evaluates each frozen wiki snapshot.

LEDGER reports two directly auditable views:

1. the state of every current factual claim in the wiki; and
2. whether known-obsolete public API facts are still presented as current.

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
classify every text unit and extract atomic claims
        │
        ▼
remove normalized exact duplicates
        │
        ▼
retrieve bounded current source evidence
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

Current claims are grounded against current evidence first; historical snapshots
cannot crowd current truth out of the retrieval window. A named source path is
always included, and a claim naming a missing file receives the complete tracked-
file manifest. Small corpora are supplied in full. Larger corpora retain
mandatory evidence plus at least the eight best BM25 matches within a soft
character budget. Byte-identical historical excerpts are deduplicated, and
historical evidence is consulted only after current source establishes a
contradiction. Every selected evidence identity, cache hit, and historical
follow-up is preserved in the assertion inventory.

Evaluator failures do not abort the run. A claim-grounding judgment that remains
invalid after isolated repair falls back to `unverified`; a failed extraction
unit contributes no claims. Both cases lower the separately reported evaluator
completeness rate and remain visible as warnings in the audit report.

## Forgetting

Source absence is not always sufficient to refute a claim. LEDGER therefore keeps
a separate deterministic watchlist for structural public-API changes.

At each checkpoint the TypeScript surface extractor records authored
`.ts`/`.tsx`/`.mts`/`.cts` files, their exported symbols, and an exported
`VERSION` constant or `package.json` version when present. Declaration files,
tests, generated wiki content, dependencies, and build output are excluded.
Diffing consecutive surfaces identifies changed and removed fact versions. Those
obsolete versions stay under watch while they remain obsolete, even after first
being judged forgotten; an exact source revival removes the version from the
watchlist.

The forgetting evaluator asks whether each obsolete fact is still presented as
current. It inspects BM25-ranked wiki sections first, then exhaustively checks all
remaining sections before declaring the fact forgotten:

| Verdict         | Meaning                                                     |
| --------------- | ----------------------------------------------------------- |
| `forgotten`     | The obsolete fact is absent or described only historically. |
| `lingering`     | The wiki still presents the obsolete fact as current.       |
| `indeterminate` | The evaluator could not complete the judgment.              |

This produces forgotten and carried obsolete facts at each checkpoint plus
stale-knowledge lifetime, measured as the number of checkpoints judged
`lingering` before the first `forgotten` verdict. Indeterminate judgments reduce
evaluator completeness and are excluded from the report's forgetting-rate
denominator. In the live CLI, an indeterminate obsolete fact remains in the
`carrying` count and is accompanied by an evaluator warning.

The source surface is an obsolete-knowledge oracle only. It is not reported or
scored as documentation coverage.

## LEDGER score

The run-level score summarizes claim health and forgetting without claiming to
measure documentation completeness:

```text
claim health = supported current claims / all current claims across checkpoints
forgetting   = forgotten / determinate obsolete-fact checks
LEDGER score = harmonic mean(claim health, forgetting)
```

Stale, hallucinated, and unverified claims all lower claim health because they
remain in its denominator. The sticky forgetting watchlist makes a lingering
obsolete fact lower forgetting again at every checkpoint until it is removed.
When a trace has no determinate forgetting opportunity, claim health is the only
observed dimension and becomes the score. The score does not measure whether the
wiki covers every important source topic; that limitation remains explicit.

## CLI output

```text
┌ 🧪 LEDGER · taskflow · medium
│ 5 checkpoints · anthropic · system claude-opus-4-8 · evaluator claude-opus-4-8
│ 📦 Replay workspace ready
│
├ 📍 1/5 · T0 · 3f2a1b9 · baseline API
│ 🤖 OpenWiki init complete · 5.4s · 12 documents
│ 📊 35 claims · 91% supported · 0% stale · 3% hallucinated · 6% unverified
│
├ 📍 2/5 · T1 · a7c40e2 · RedisStore + retry API
│ 🤖 OpenWiki update complete · 6.8s · 14 documents
│ 📊 50 claims · 88% supported · 4% stale · 2% hallucinated · 6% unverified
│ 🧹 forgot 2/3 obsolete facts · carrying 1
│
├ 🔬 Details → evals/ledger/.results/taskflow-…/report.md
└ ✅ LEDGER score 84% · 2m 11s
```

The displayed claim count is the shared snapshot denominator: distinct current-
tense claims after exact deduplication. Individual claims, citations, evaluator
warnings, and stale lifetimes are kept in `report.md`, `result.json`, the
assertion inventories, evidence snapshots, and, when current unverified claims
exist, `unverified-claims.md`.

While evaluation is active, the spinner reports phase-specific completion:

```text
│ ⠼ 🔍 Extracting claims · 44% · 0 obsolete API facts
│ ⠼ 🔍 Grounding 35 claims · 49% · 0 obsolete API facts
```

Extraction advances by classified text units. After extraction, grounding
progress combines distinct-claim judgments and obsolete-fact judgments, so 100%
means the checkpoint evaluation is genuinely complete.

## Running

```bash
OPENWIKI_PROVIDER=anthropic \
LEDGER_EVALUATOR_MODEL_ID=claude-sonnet-5 \
pnpm run eval:ledger -- --benchmark evals/ledger/benchmarks/taskflow
```

Provider credentials use the same environment configuration as OpenWiki. Add
`--system-model <id>` or `--evaluator-model <id>` to override either model.

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
