# KEB

### Benchmark how well knowledge stays correct as code evolves.

KEB — the **Knowledge Evolution Benchmark** — measures how well a documentation system builds and maintains a wiki across real source-code changes.

Instead of grading one static generation, KEB replays a frozen Git history:

```text
T0 → init   → wiki K0 → evaluate
T1 → update → wiki K1 → evaluate
T2 → update → wiki K2 → evaluate
...
```

It measures whether the system:

- **covers what is true**
- **avoids unsupported claims**
- **discovers new knowledge**
- **corrects changed knowledge**
- **forgets stale knowledge**
- **preserves knowledge that did not change**

KEB was built to evaluate OpenWiki, but the benchmark separates the system under test from the scoring core so different implementations can run against the same frozen benchmark.

## How it works

A KEB benchmark contains:

- a Git repository
- an ordered sequence of checkpoint commits
- a **Truth Ledger** describing the material knowledge that is true at each checkpoint

KEB creates an isolated Git worktree, runs the system at each checkpoint, freezes the resulting wiki, and evaluates it against the Truth Ledger.

Evaluation uses the frozen in-memory document set directly. Markdown is split
into stable, size-bounded sections, then one BM25 index is reused to retrieve the
most relevant evidence for coverage and forgetting. A missing or forgotten
verdict is provisional until the evaluator has exhausted every remaining
section, preventing retrieval misses from becoming final negative judgments.

All semantic judgments use schema-validated direct model calls with fixed batch
sizes, a five-minute per-attempt timeout, at most two attempts, zero provider
retries, and temperature zero. Passes run sequentially, so call counts and
failure boundaries remain bounded and observable. Precision visits every
section rather than using retrieval and compares every extracted assertion with
the complete active Truth Ledger.

For OpenWiki, the generated wiki persists between checkpoints, so `update` sees the artifact produced by the previous run:

```text
repo @ T0
   ↓
  init
   ↓
 wiki K0
   ↓
repo @ T1 + K0
   ↓
 update
   ↓
 wiki K1
```

This makes the benchmark longitudinal: later scores depend on how well the system maintained what it already knew.

## Score

KEB reports a 0–100 score made from **Quality** and **Maintenance**.

```text
KEB Score = (Quality + Maintenance) / 2
```

### Quality

Quality measures the wiki at every checkpoint.

**Knowledge Coverage**

How much expected knowledge does the wiki represent correctly?

```text
correct active facts
────────────────────
all active facts
```

**Factual Precision**

How many material claims made by the wiki are supported by ground truth?

```text
supported assertions
────────────────────
all material assertions
```

KEB extracts assertions from every deterministic artifact section in bounded
batches, then judges those assertions against the complete active Truth Ledger.
V1 collapses assertions only when their whitespace-normalized text is identical
after terminal punctuation is removed. Differently worded semantic duplicates
remain separate assertions; avoiding an additional model grouping pass keeps the
precision denominator more deterministic and auditable.

Coverage and Precision are averaged across checkpoints, then combined using their harmonic mean.

### Maintenance

Maintenance measures how the artifact reacts when truth changes.

- **New-Knowledge Discovery** — did newly true facts appear?
- **Changed-Knowledge Correction** — did the new truth appear and the old truth disappear?
- **Complete Forgetting** — did removed knowledge disappear?
- **Stable Retention** — did previously correct, unchanged knowledge stay correct?

The four rates are computed over the full trace and averaged into the Maintenance Score.

## Diagnostics

KEB also reports longitudinal signals that do not affect the headline score.

**Recovery Rate** measures how often an initially missed introduction, change, or removal is repaired at a later checkpoint.

**Stale-Knowledge Lifetime** measures how many checkpoints obsolete knowledge remains in the wiki before it is first forgotten.

**Efficiency** reports runtime and knowledge churn. Token usage and cost can optionally be collected as well.

## The Truth Ledger

The Truth Ledger is the benchmark's ground truth.

A benchmark should not contain only the facts that happen to change during its trace. At every checkpoint, the active ledger should describe the **material knowledge a good wiki is expected to know**.

That typically includes things like:

- public APIs and configuration
- defaults and user-visible behavior
- architecture and major components
- important execution flows
- extension points and abstractions
- meaningful constraints and failure behavior

Facts should be atomic and independently checkable.

For example:

```json
{
  "id": "write-file-semantics",
  "category": "api",
  "versions": [
    {
      "statement": "write_file refuses to overwrite an existing file.",
      "fromCheckpoint": "T0",
      "untilCheckpoint": "T5"
    },
    {
      "statement": "write_file overwrites an existing file.",
      "fromCheckpoint": "T5"
    }
  ]
}
```

The same logical fact keeps its `id` as its truth evolves.

For the full benchmark-authoring contract, see [`BENCHMARK_SPEC.md`](./BENCHMARK_SPEC.md).

## Authoring a benchmark

Start with the initial checkpoint and build a census of the repository's material knowledge.

For a small repository, that can be done manually.

For a larger repository, the expected workflow is:

```text
repository @ T0
      ↓
independent analysis
      ↓
draft Truth Ledger
      ↓
human review
```

At later checkpoints, evolve that complete ledger:

```text
previous Truth Ledger
+
source changes
      ↓
introduced / changed / removed facts
      ↓
review
```

The question at every checkpoint is:

> What should a high-quality wiki know now?

not just:

> What changed in this commit?

Ground truth should be authored independently of the system being evaluated and frozen before comparing treatments.

## Run KEB

Configure the OpenWiki system and evaluator models:

```sh
export OPENWIKI_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...

export OPENWIKI_MODEL_ID=claude-sonnet-5
export KEB_EVALUATOR_MODEL_ID=claude-sonnet-5
```

Run a benchmark:

```sh
pnpm exec tsx evals/keb/run.ts \
  --benchmark evals/keb/benchmarks/example
```

Results are written under:

```text
evals/keb/.results/
```

Each run produces:

```text
result.json
report.md
```

## Compare systems

A comparison should keep the benchmark fixed:

```text
same repository
same commits
same Truth Ledger
same evaluator
same repetition count
```

and change only the system under test.

For example:

```text
OpenWiki baseline
        vs.
OpenWiki + Grounded Claims
```

This makes KEB useful for measuring whether a change actually improves knowledge maintenance rather than merely producing different documentation.

## Tests

Run the deterministic benchmark core:

```sh
pnpm exec vitest run evals/keb
pnpm run eval:keb:typecheck
```

Include live system and evaluator tests:

```sh
KEB_LIVE=1 pnpm exec vitest run evals/keb
```

Live tests require provider credentials; the deterministic core does not.
