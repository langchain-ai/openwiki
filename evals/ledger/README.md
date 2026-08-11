# LEDGER 🧪

LEDGER measures whether an evolving knowledge artifact remains grounded as its
source changes. The current adapter replays Git checkpoints, runs OpenWiki, and
evaluates each frozen wiki snapshot.

LEDGER deliberately does not produce a composite quality score. It reports two
directly auditable views:

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

The rates therefore sum to 100%. `Unverified` is not treated as a factual error;
it is the audit worklist and confidence boundary around the known results.

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
retrieve the claim's top eight current/historical source excerpts
        │
        ▼
supported / contradicted / not addressed
        │
        ├ contradicted + formerly true → stale
        ├ contradicted + never true    → invented
        └ not addressed                → unverified
```

Source evidence is every tracked non-binary Git file except the generated
`openwiki/` artifact. Current evidence comes from the active checkpoint; earlier
checkpoint evidence is marked historical. Every adjudicated verdict cites the
exact evidence records visible to the judge.

## Forgetting

Source absence is not always sufficient to refute a claim. LEDGER therefore keeps
a separate deterministic watchlist for structural public-API changes.

At each checkpoint the TypeScript surface extractor records exported symbols,
parseable source files, and the package version. Diffing consecutive surfaces
identifies changed and removed fact versions. Those obsolete versions stay under
watch while they remain obsolete.

The forgetting evaluator asks whether each obsolete fact is still presented as
current:

| Verdict         | Meaning                                                     |
| --------------- | ----------------------------------------------------------- |
| `forgotten`     | The obsolete fact is absent or described only historically. |
| `lingering`     | The wiki still presents the obsolete fact as current.       |
| `indeterminate` | The evaluator could not complete the judgment.              |

This produces forgotten and carried obsolete facts at each checkpoint plus
stale-knowledge lifetime, measured in checkpoints until first forgotten.

The source surface is an obsolete-knowledge oracle only. It is not reported or
scored as documentation coverage.

## CLI output

```text
┌ 🧪 LEDGER · taskflow · medium
│ 5 checkpoints · anthropic · system claude-opus-4-8 · evaluator claude-opus-4-8
│ 📦 Replay workspace ready
│
├ 📍 1/5 · T0 · 3f2a1b9 · baseline API
│ 🤖 OpenWiki init complete · 5.4s · 12 documents
│ 📊 claims · 91% supported · 0% stale · 3% hallucinated · 6% unverified
│
├ 📍 2/5 · T1 · a7c40e2 · RedisStore + retry API
│ 🤖 OpenWiki update complete · 6.8s · 14 documents
│ 📊 claims · 88% supported · 4% stale · 2% hallucinated · 6% unverified
│ 🧹 forgot 2/3 obsolete facts · carrying 1
│
├ 🔬 Details → .ledger/runs/…/report.md
└ ✅ Complete · 2m 11s
```

Counts, individual claims, citations, evaluator warnings, and stale lifetimes are
kept in `report.md`, `result.json`, the assertion inventories, evidence snapshots,
and `unverified-claims.md`.

## Running

```bash
pnpm run eval:ledger -- --benchmark evals/ledger/benchmarks/taskflow
```

Re-evaluate a completed run without invoking OpenWiki again:

```bash
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
