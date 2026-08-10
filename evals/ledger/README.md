# LEDGER 🧪

**LEDGER (Longitudinal Evaluation of Drift, Grounding, Evolution, and
Retention) measures whether knowledge artifacts stay complete, accurate, and
current as their underlying truth changes.**

A knowledge artifact might be a repository wiki, a personal brain, an internal
knowledge base, generated documentation, or another maintained representation of
changing source material. LEDGER's evaluation model is source- and artifact-agnostic;
the executable V1 runner currently implements Git checkpoints, OpenWiki, and
Markdown artifacts.

Most evaluations inspect one artifact once. LEDGER supports both point-in-time and
longitudinal evaluation:

```text
Point in time
truth @ T0 → artifact K0 → evaluate quality

Longitudinal
truth @ T0 → create K0 → evaluate
truth @ T1 → update K1 → evaluate change handling
truth @ T2 → update K2 → evaluate change handling
```

LEDGER asks three core questions:

| Question                                               | Metric         | Plain-English meaning                                               |
| ------------------------------------------------------ | -------------- | ------------------------------------------------------------------- |
| 📚 Did the artifact represent what matters?            | **Coverage**   | Required knowledge appears correctly in the artifact.               |
| 🎯 Is what the artifact says supported?                | **Precision**  | Claims are checked against requirements, then source evidence.      |
| 🧹 Did the artifact stop presenting what became false? | **Forgetting** | Obsolete requirements are no longer presented as current knowledge. |

Those checkpoint judgments also produce longitudinal maintenance metrics for
discovering new knowledge, correcting changed knowledge, forgetting stale
knowledge, and retaining unchanged knowledge.

## 🧱 What is a benchmark?

A benchmark is the frozen source evolution and its human-authored expectations:

```text
Benchmark
├── ordered source-truth states or events
├── checkpoint boundaries
└── Truth Package
    ├── material knowledge requirements
    ├── temporal validity and supersession
    └── optional human-audit evidence references

Evaluation run
├── benchmark
├── system under test
├── source-evidence adapter
└── evaluator
```

In the current manifest schema, the **Truth Package** is the human-authored
ground-truth specification: material knowledge requirements and their validity
ranges. During a run, the separately supplied source-evidence adapter normalizes
the frozen source at each checkpoint into an evidence corpus. Requirements define
what a useful artifact must cover; source evidence verifies additional details
the artifact chooses to state.

The benchmark is broader than the Truth Package because it also defines the
evolving source truth and checkpoint sequence. The system under test, source
adapter, and evaluator are run inputs, which allows the same benchmark to compare
different systems without changing its truth definition. The system under test
never creates or modifies the requirements or source evidence.

Possible source evolutions include:

| Domain         | Source truth over time                   | Knowledge artifact                 |
| -------------- | ---------------------------------------- | ---------------------------------- |
| Code           | Repository snapshots or commits          | Repository wiki                    |
| Personal brain | Added, edited, or deleted notes/messages | Maintained personal knowledge base |
| Operations     | Configuration and runbook changes        | Operational documentation          |
| Organization   | Policies, people, and process changes    | Internal knowledge hub             |

Git commits are therefore one convenient way to define repeatable checkpoints,
not part of LEDGER's conceptual requirement.

### Current Git/OpenWiki implementation

The first LEDGER adapter uses Git commits as source-truth checkpoints and OpenWiki
as the system under test. The committed `calc-evolution` benchmark has three
checkpoints:

| Checkpoint | Repository change             | Selected active truth                                                   |
| ---------- | ----------------------------- | ----------------------------------------------------------------------- |
| T0         | calc 1.0.0                    | `add` and `negate` exist; `VERSION` is `"1.0.0"`.                       |
| T1         | Introduce `subtract`          | `add`, `negate`, and `subtract` exist; version remains `"1.0.0"`.       |
| T2         | Remove `negate`, bump version | `add` and `subtract` exist; `negate` is absent; `VERSION` is `"2.0.0"`. |

An individual knowledge requirement keeps the same ID while its truth changes:

```json
{
  "id": "current-version",
  "category": "config",
  "versions": [
    {
      "statement": "The library's current version is 1.0.0.",
      "evidenceRefs": ["src/version.ts", "README.md"],
      "fromCheckpoint": "T0",
      "untilCheckpoint": "T2"
    },
    {
      "statement": "The library's current version is 2.0.0.",
      "evidenceRefs": ["src/version.ts", "README.md"],
      "fromCheckpoint": "T2"
    }
  ]
}
```

At T1, LEDGER selects the first version. At T2, it selects the second version and
treats the first as obsolete knowledge that the artifact must forget.

`evidenceRefs` are optional, human-auditable pointers documenting where a
requirement came from. In V1 they do not affect retrieval or scoring. The Git
source adapter captures all tracked text files except generated `openwiki/`
content, binary files, and non-file entries; it does not restrict evidence to
these references.

## 🗺️ End-to-end architecture

```mermaid
flowchart TD
    B[Load benchmark] --> C[Advance source truth to checkpoint]
    C --> F{First checkpoint?}
    F -->|Yes| I[Create knowledge artifact]
    F -->|No| U[Update knowledge artifact]
    I --> A[Freeze artifact]
    U --> A
    A --> L[Project truth ledger and collect source evidence]
    L --> CV[Coverage]
    CV --> FG[Forgetting]
    FG --> EX[Stage 1: classify units and extract atomic, tense-tagged claims]
    EX --> DD{Exact duplicate?}
    DD -->|Yes| DX[Drop and record]
    DD -->|No| TL[Stage 2: account against active and superseded ledger facts]
    TL -->|Supported| SP[Supported]
    TL -->|Contradicted and never true| IN[Invented]
    TL -->|Contradicted and formerly true| ST[Stale]
    TL -->|Unaccounted historical| UV[Unverified]
    TL -->|Unaccounted current| SE[Stage 3: BM25 top-k source refutation]
    SE -->|Contradicted and never true| IN
    SE -->|Contradicted and formerly true| ST
    SE -->|Not refuted| UV
    DX --> SC[Score checkpoint]
    SP --> SC
    IN --> SC
    ST --> SC
    UV --> SC
    SC --> N{More checkpoints?}
    N -->|Yes| C
    N -->|No| R[Aggregate and persist results]

    SUT[(System under test)] -. adapter .-> I
    SUT -. adapter .-> U
    EV[(Evaluator)] -. judgments .-> CV
    EV -. judgments .-> FG
    EV -. judgments .-> EX
    EV -. judgments .-> TL
    EV -. judgments .-> SE
```

At each checkpoint, LEDGER measures point-in-time quality. Across checkpoint
transitions, it measures whether the artifact adapted correctly:

```text
                              POINT-IN-TIME
requirements @ Tn ─────────compare─────────▶ artifact @ Tn
                         coverage

artifact assertions @ Tn ──▶ active requirements
                                 │
                                 ├── supported → supported
                                 ├── contradicted → stale or invented
                                 └── unaccounted current
                                         │
                                         ▼
source truth @ Tn ─────────────▶ BM25 top-k evidence → refutation only
                                                        │
                                                        ├── contradicted → stale or invented
                                                        └── not refuted → unverified

                              LONGITUDINAL
requirements Tn ──changed──▶ requirements Tn+1
                              ▲
                              │ compare evolution
                              ▼
artifact Kn ─updated─▶ artifact Kn+1
             discovery + correction + forgetting + retention
```

The artifact persists between checkpoints. In the current Git/OpenWiki adapter,
the source truth is a repository and the artifact is a wiki:

```text
repository @ T0 ──init──▶ wiki K0
                            │
repository @ T1 + wiki K0 ──update──▶ wiki K1
                                         │
repository @ T2 + wiki K1 ──update──▶ wiki K2
```

T2 therefore evaluates how well OpenWiki maintained the artifact it created at
T0 and updated at T1—not a fresh generation with no memory. LEDGER's contracts are
designed to support note edits, messages, policy revisions, database snapshots,
or timestamped events, but V1 would need additional replay and artifact adapters
to run those domains end to end.

### One checkpoint, step by step

| Step | Generic LEDGER operation                                     | Current Git/OpenWiki adapter                            |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------- |
| 1    | Load checkpoint definitions and knowledge requirements.      | Load commits and `benchmark.json`.                      |
| 2    | Materialize the checkpoint's source truth.                   | Check out a commit in an isolated worktree.             |
| 3    | Ask the system under test to create or update its artifact.  | Run OpenWiki `init` or `update` using the system model. |
| 4    | Freeze and persist the artifact before evaluation.           | Capture every generated wiki document.                  |
| 5    | Project requirements and collect temporal source evidence.   | Requirements plus current and prior tracked files.      |
| 6    | Evaluate coverage of every active material topic.            | BM25 retrieval plus evaluator-model judgment.           |
| 7    | Evaluate whether obsolete fact versions were forgotten.      | BM25 retrieval plus evaluator-model judgment.           |
| 8    | Classify text units and extract atomic, tense-tagged claims. | Evaluator-model extraction plus exact deduplication.    |
| 9    | Account each claim against the truth ledger.                 | Active and superseded ledger-fact judgment.             |
| 10   | Refute unaccounted current claims from source evidence.      | One bounded BM25 top-eight judgment, then stop.         |
| 11   | Score the checkpoint and, finally, the complete trace.       | Deterministic calculation and persistence.              |

LEDGER does not require the system under test to use a model. The current OpenWiki
system does, and may perform many agent calls. The current evaluator also uses a
model for semantic judgments, split into stable, bounded batches.

The current implementation has two intentionally separate model roles:

| Role                   | Responsibility                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| 🤖 **System model**    | Operates OpenWiki and creates or updates the artifact being evaluated.                    |
| ⚖️ **Evaluator model** | Extracts assertions and judges coverage, precision, and forgetting from bounded evidence. |

The models do not generate benchmark requirements, checkpoint definitions,
source-evidence records, BM25 rankings, temporal transitions, metrics, or scores.
Those remain human-authored or deterministic code paths.

In the current adapter, Git replay, requirement projection, source-evidence
capture, Markdown sectioning, BM25 retrieval, exact deduplication, scoring, and
persistence are deterministic code paths.

## 📚 Coverage: did the artifact represent what is true?

Coverage starts from the active knowledge requirements and searches the artifact.

```text
active knowledge requirement
        │
        ▼
retrieve likely artifact sections
        │
        ▼
evaluator judges all supplied sections together
        │
        ├── correct
        ├── partial
        ├── contradicted
        └── missing
```

In the current Markdown evaluator, BM25 initially retrieves the eight most
relevant artifact sections for each active fact. The evaluator receives the fact
and those candidate sections.

### Worked coverage example

Active T1 requirement:

```text
subtract(a, b) returns the first argument minus the second.
```

Possible artifact evidence and verdicts:

| Artifact text                       | Verdict        | Why                                       |
| ----------------------------------- | -------------- | ----------------------------------------- |
| “`subtract(a, b)` returns `a - b`.” | `correct`      | The complete fact is accurate.            |
| “The library exports `subtract`.”   | `partial`      | It confirms existence but omits behavior. |
| “`subtract(a, b)` returns `b - a`.” | `contradicted` | It states incompatible behavior.          |
| No section describes `subtract`.    | `missing`      | The artifact does not represent the fact. |

A model may initially return `missing` because BM25 did not retrieve the right
section. LEDGER therefore treats `missing` as provisional and checks every remaining
section in bounded batches before finalizing it.

```text
top BM25 sections say missing
             │
             ▼
inspect every unexamined section
             │
             ├── find support → correct or partial
             └── find none    → final missing
```

This keeps retrieval quality from silently becoming a coverage failure.

## 🎯 Precision: is what the artifact says supported?

Precision runs in the opposite direction from coverage. Coverage starts with
human-authored requirements. Precision starts with every code-owned text unit in
the artifact, extracts atomic claims, accounts for the claims the truth ledger
can adjudicate, and asks the source repository only whether remaining current
claims can be refuted.

```mermaid
flowchart TD
    W[Artifact text units] --> E[Stage 1: classify and extract atomic claims]
    E --> D{Exact duplicate?}
    D -->|Yes| X[Drop and record]
    D -->|No| L[Stage 2: truth-ledger accounting]
    L -->|Supported| SP[Supported]
    L -->|Contradicted| FT{Formerly true?}
    FT -->|No| IN[Invented]
    FT -->|Yes| ST[Stale]
    L -->|Unaccounted historical| UV[Unverified]
    L -->|Unaccounted current| R[Stage 3: BM25 top-k refutation]
    R -->|Not refuted| UV
    R -->|Contradicted| SF{Formerly true?}
    SF -->|No| IN
    SF -->|Yes| ST
```

The truth ledger is the scoreable contract: the human declaration of what
matters. It is not an inventory of everything true in the source. Mere
consistency is not support, and ledger silence is not contradiction.

### Stage 1: extract accountable atomic claims

Before truth judgment, the evaluator must return exactly one classification for
every supplied Markdown block:

| Text                                                   | Classification  | Extracted claim and tense            |
| ------------------------------------------------------ | --------------- | ------------------------------------ |
| “`add(a, b)` returns `a + b`.”                         | `factual`       | Complete behavior claim; `current`   |
| “Because there are no tests, validate manually.”       | `mixed`         | “There are no tests”; `current`      |
| “`negate` was removed in 2.0.0.”                       | `factual`       | Complete removal claim; `historical` |
| “See the API page.”                                    | `navigation`    | None                                 |
| “This wiki documents every export.”                    | `meta-artifact` | None                                 |
| “This library is elegant.”                             | `opinion`       | None                                 |
| “Run the functions manually.”                          | `instruction`   | None                                 |
| A heading or transition with no subject-matter meaning | `no-claim`      | None                                 |

This is model-based because the distinction is semantic, but it is accountable:
a unit cannot silently disappear, factual and mixed units must produce claims,
excluded units must produce none, and every decision is persisted with a
rationale. Claims are atomic, self-contained, detail-preserving, and tagged as
`current` or `historical`. Compounds are split when their parts could receive
different verdicts, pronouns are resolved without adding facts, and exact names,
values, defaults, conditions, and exceptions are preserved. Only normalized
exact duplicates are removed.

The extraction taxonomy is the only semantic filtering layer. Navigation, wiki
self-description, commit archaeology, editorial asides, hypothetical future
work, prescriptive advice, opinions, and text with no claim are handled here—not
by code-side regex families.

### Stage 2: account against the truth ledger

Each deduplicated claim is judged against active and superseded fact versions:

| Ledger verdict                        | Routing                                                 |
| ------------------------------------- | ------------------------------------------------------- |
| `supported`                           | Final `supported` verdict.                              |
| `contradicted`, `formerlyTrue: false` | Final `invented` verdict.                               |
| `contradicted`, `formerlyTrue: true`  | Final `stale` verdict, citing superseded fact versions. |
| `unaccounted`, historical claim       | Final `unverified` verdict.                             |
| `unaccounted`, current claim          | Continue to source refutation.                          |

Historical claims can be supported by superseded fact versions and declared
transitions. The same ledger judgment that finds a contradiction determines
whether the claim was formerly true; there is no extra stale-detection pass.

### Stage 3: refute from bounded source evidence

For each unaccounted current claim, BM25 selects the top eight current and
historical source-evidence records. The judge receives that bounded context once
and may return only `contradicted` or `not-refuted`:

- `contradicted` requires cited current evidence establishing incompatible truth;
- `formerlyTrue: true` additionally requires cited historical evidence showing
  that the complete claim held earlier; and
- `not-refuted` means only that the supplied evidence did not disprove the claim.

The source repository is a refuter, never a certifier. Absence of evidence is not
contradiction, and source evidence never produces a `supported` verdict. The
judge may apply ordinary language and runtime semantics to supplied code, such
as arithmetic and direct control flow. Retrieval ends after the one bounded
judgment: a missed refutation is a tolerated sampling false negative, measured by
the defect harness rather than chased with a scan-everything fallback.

### Final classes and worked example

Every deduplicated claim ends in exactly one class:

| Class        | Meaning                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `supported`  | Established by the active truth ledger.                                |
| `invented`   | Refuted as false and never true—a hallucination.                       |
| `stale`      | False now but established in a former world state—a failure to forget. |
| `unverified` | Neither established nor refuted.                                       |

Suppose the active ledger establishes that `add(a, b)` returns `a + b`, and the
artifact also claims that `add` validates both inputs and that no CI workflow
exists. The first claim is `supported`. If retrieved source evidence directly
shows that `add` performs no validation, the second is `invented`. If the bounded
evidence neither establishes nor refutes the absence of CI, the third is
`unverified`—reported as a padding diagnostic, not treated as a hallucination.

If an isolated source-judgment repair also fails, the claim is conservatively
recorded as `unverified` with an audit warning. Evaluator failures never create an
`invented` or `stale` verdict.

## 🧹 Forgetting: did stale knowledge disappear?

Forgetting checks prior requirement versions that are no longer active.

```text
obsolete requirement version
          │
          ▼
retrieve likely artifact sections
          │
          ▼
evaluator checks whether the old claim is still current
          │
          ├── lingering
          └── forgotten
```

### Worked forgetting example

At T1:

```text
negate(x) is exported.
```

At T2, `negate` is removed. The T1 statement becomes an obsolete fact version.
LEDGER searches the T2 artifact for that old knowledge:

| T2 artifact text                         | Verdict     | Why                                                     |
| ---------------------------------------- | ----------- | ------------------------------------------------------- |
| “`negate(x)` returns `-x`.”              | `lingering` | The artifact still presents the removed API as current. |
| “`negate` was removed in version 2.0.0.” | `forgotten` | Historical removal is not a current claim.              |
| No mention of `negate` anywhere.         | `forgotten` | The stale fact is absent.                               |

Like coverage, an initial `forgotten` verdict is provisional. LEDGER checks every
remaining section before finalizing it because stale knowledge could be hiding
elsewhere in the artifact.

Forgetting does not require the artifact to erase history. Migration notes and
explicit statements that something was removed are allowed; the old behavior
must simply not be presented as current truth.

## 📊 Scoring

LEDGER combines **Quality** and **Maintenance**:

```text
LEDGER Score = (Quality + Maintenance) / 2
```

### Quality

Quality evaluates the artifact at every checkpoint.

```text
Checkpoint Coverage = correct active requirements / active requirements

Trace Coverage = mean of checkpoint Coverage scores

Adjudicated Claims = supported + invented + stale

Checkpoint Precision = supported / adjudicated
Checkpoint Hallucination Rate = invented / adjudicated
Checkpoint Staleness Rate = stale / adjudicated
Checkpoint Unverified Rate = unverified / all deduplicated claims

Trace metrics = mean of their defined checkpoint values

Quality = harmonic mean(Trace Coverage, Trace Precision)
```

The checkpoint macro-average gives each checkpoint equal weight even when they
contain different numbers of requirements or assertions. The harmonic mean makes
a system earn both coverage and precision. `Unverified` claims never enter a
score denominator and are never a penalty. They remain visible as the padding
guardrail, while coverage anchors the ledger side and prevents a system from
earning quality by saying nothing.

If a checkpoint has no adjudicated claims, its precision, hallucination rate,
and staleness rate are `null`; the run succeeds with a report warning. Null
checkpoints are excluded from each trace mean. If trace precision is entirely
null, Quality and the final LEDGER Score are null. Unverified Rate is zero when no
claims were extracted.

### Maintenance

Maintenance evaluates transitions between checkpoints:

| Metric                              | Question                                              |
| ----------------------------------- | ----------------------------------------------------- |
| 🌱 **New-Knowledge Discovery**      | Did newly true facts appear?                          |
| 🔄 **Changed-Knowledge Correction** | Did the new truth appear and the old truth disappear? |
| 🧹 **Complete Forgetting**          | Did removed knowledge stop appearing as current?      |
| 🛡️ **Stable Retention**             | Did correct, unchanged knowledge remain correct?      |

The eligible rates are averaged into the Maintenance score.

### Diagnostics

LEDGER also reports signals that do not affect the headline score:

- **Recovery Rate** — whether a missed introduction, change, or removal is fixed
  at a later checkpoint.
- **Stale-Knowledge Lifetime** — how many checkpoints obsolete knowledge lingers
  before it is first forgotten.
- **Efficiency** — system runtime and documentation churn. Token and cost capture
  can be added when usage telemetry is available.

Precision also reports its composition:

- **Supported** — active-ledger-established claims;
- **Invented** — false claims that were never true;
- **Stale** — false current claims that were true at an earlier checkpoint; and
- **Unverified** — claims neither established nor refuted.

The report prints assertion-side Staleness Rate beside fact-side forgetting at
each checkpoint. They measure the same failure from opposite directions and
should broadly correlate; divergence is a debugging signal, not another score.

Evaluator Completeness is reported separately from system quality:

```text
Evaluator Completeness = valid semantic judgments / attempted judgments
```

Coverage and forgetting items that remain invalid after isolated repair become
`indeterminate`. Precision repair failures become `unverified` with an audit
warning so every extracted claim still has exactly one of the four final classes.
Evaluator failure never becomes a hallucination. Reduced Evaluator Completeness
makes the resulting LEDGER score explicitly provisional rather than quietly treating
evaluator failure as system failure.

## 📒 Authoring the Truth Package

Human-authored requirements should capture the material source truth the artifact
is expected to represent—not every mechanically observable property. The source
adapter captures the underlying evidence needed to verify additional claims.

Depending on the domain, categories might include:

- identities, entities, relationships, and attributes;
- behaviors, decisions, defaults, and configuration;
- architecture, components, processes, and execution flows;
- timelines, commitments, constraints, and meaningful absences;
- source or artifact structure; and
- facts that were introduced, changed, or removed across the trace.

Coverage facts should be meaningful, independently checkable topic claims:

```text
Avoid:
  add exists.
  add is exported.
  add has two parameters.
  add returns a number.
  add is defined in src/calc.ts.

Prefer:
  The library provides add(a, b), which returns the sum a + b.
```

Exact values and behavior remain part of the claim when they are material. “The
library exposes a version” is insufficient when the useful truth is “the current
version is 1.0.0.” File placement, declaration syntax, exact counts, and similar
implementation details are not coverage requirements by default.

Repository archaeology—commit counts, incidental file inventories, commentary
wording, fixture provenance, and absent tooling with no material consequence—is
outside the default evaluation scope.

### Authoring workflow

```mermaid
flowchart LR
    R0[Source truth at T0] --> A0[Independent analysis]
    A0 --> D0[Draft material requirements]
    D0 --> H0[Human review and freeze]
    H0 --> CH[Inspect changes in source truth]
    CH --> EV[Evolve added, changed, removed facts]
    EV --> HR[Review each checkpoint projection]
```

For a small source set, author requirements manually. For a larger domain, a model
may help draft candidates from independent source analysis, but a human must
review and freeze the result before evaluation. The system under test's artifact
must never be used as ground truth.

Ask at each checkpoint:

> What should a high-quality artifact represent now?

not merely:

> What changed since the preceding checkpoint?

The executable requirement schema and validation rules live in
[`core/types.ts`](./core/types.ts) and
[`benchmark/validation.ts`](./benchmark/validation.ts).

## 🔬 Evaluator mechanics and reliability

The current evaluator splits generated Markdown into stable, bounded sections and
then into fence-aware text units. Coverage and forgetting reuse one BM25 index
over artifact sections. Precision classifies every text unit, exact-deduplicates
the extracted claims, accounts them against active and superseded ledger facts,
then uses a separate BM25 index for one top-eight refutation judgment on each
unaccounted current claim. The source-evidence interface is generic, but the V1
runner still directly owns Git replay, OpenWiki execution, and Markdown capture;
other domains require those additional adapters.

Semantic judgments use direct schema-validated model calls with:

- stable bounded batches;
- exactly one extraction classification per supplied text unit;
- a five-minute timeout per attempt;
- at most two attempts;
- provider retries disabled inside each attempt;
- sequential passes and observable failure boundaries; and
- no evaluator-forced sampling parameter.

The reviewed boundary examples used by deterministic evaluator tests live in
[`evaluator/fixtures/precision-gold.json`](./evaluator/fixtures/precision-gold.json).
They intentionally cover navigation, opinion, instruction, mixed content,
meta-artifact text, tense, direct code inference, explicit contradiction, and
formerly-true boundaries.

Evidence citations must name sections that were actually supplied in the bounded
request. An initial provider failure, schema-wide failure, or unusable assertion
inventory still fails the pass because there is no trustworthy batch to preserve.
When a schema-valid judgment batch contains one malformed item, LEDGER preserves
valid neighboring judgments and retries only that item with isolated evidence.
If both isolated attempts fail, an audit warning is persisted. Coverage and
forgetting items become `indeterminate`; precision items become `unverified`.

## 💾 Audit artifacts

Every run writes to a timestamped directory under `evals/ledger/.results/`:

```text
calc-evolution-<timestamp>/
├── artifacts/
│   ├── T0/                 # exact frozen artifact at T0
│   ├── T0.json             # fingerprint and document inventory
│   ├── T1/
│   ├── T1.json
│   ├── T2/
│   └── T2.json
├── assertions/
│   ├── T0.json             # classified units plus all excluded/retained claims
│   ├── T1.json
│   └── T2.json
├── evidence/
│   ├── T0.json             # normalized source evidence used by precision
│   ├── T1.json
│   └── T2.json
├── result.json             # verdicts, warnings, scores, and diagnostics
├── report.md               # completed runs: detailed human-readable report
└── error.json              # failed runs: bounded failure details
```

Artifacts and source evidence are persisted before evaluation, and assertion
inventories are persisted before precision judgment. They therefore survive
later evaluator failures and can be inspected without reading provider traces.

The assertion inventory is the main precision-tuning artifact. For every text
unit it records the classification, extracted claims, and rationale; for every
claim it records deterministic exclusions, deduplication, stable assertion IDs,
and final verdict provenance.

## ▶️ Running the Git/OpenWiki adapter

Configure the provider and model IDs. Store provider credentials in the expected
environment variable; never commit them to the repository.

```sh
export OPENWIKI_PROVIDER=anthropic
export OPENWIKI_MODEL_ID=claude-sonnet-5
export LEDGER_EVALUATOR_MODEL_ID=claude-sonnet-5

# Set ANTHROPIC_API_KEY in your shell or secret manager.
```

Run the calc benchmark:

```sh
pnpm exec tsx evals/ledger/run.ts \
  --benchmark evals/ledger/benchmarks/calc-evolution
```

The terminal shows checkpoint progress and a compact precision composition:

```text
│ ✅ T1 · coverage 83% · precision 92% · halluc 3% · stale 5% · unverified 31% · forgetting 100% (2/2)
│    ↳ 16 claims · 9 supported · 1 invented · 1 stale · 5 unverified
```

Detailed claim text, provenance, and citations remain in the result directory
rather than being dumped to the terminal.

### Re-evaluate a saved run

Evaluator tuning does not require regenerating the knowledge artifact. A
completed run already contains the exact artifact and source-evidence snapshots
for every checkpoint. Re-evaluate them with:

```sh
pnpm run eval:ledger:reevaluate \
  --benchmark evals/ledger/benchmarks/calc-evolution \
  --run evals/ledger/.results/calc-evolution-<timestamp> \
  --evaluator-model claude-sonnet-5
```

This does **not** invoke OpenWiki or replay the source repository. It reprojects
the active requirements and obsolete versions, reruns every semantic evaluator
pass, recomputes all point-in-time and longitudinal scores, and writes a new
standalone audit directory. The new result preserves the original system runtime
and model metadata only as observations; no prior semantic verdict is reused.

## ⚖️ Comparing systems

A valid comparison holds every evaluation input constant:

```text
same source evolution and checkpoints
same Truth Package and source evidence
same evaluator model
same repetition count
             │
             ▼
change only the system under test
```

For example:

```text
OpenWiki baseline
        vs.
OpenWiki + grounded claims
```

This isolates whether the system change improved knowledge maintenance rather
than merely generating a different artifact.

## 🧪 Meta-evaluation

The optional provider-backed tier treats the evaluator as a calibrated
instrument rather than patching individual misses in production code:

- the gold-agreement gate measures extraction, truth-ledger accounting, and
  refutation against human-reviewed cases, requiring at least 0.90 agreement for
  each stage; and
- the defect harness evaluates captured clean artifacts plus five mutations:
  invented fact, stale fact, coverage gap, spurious deletion, and unverified
  padding. Every defect must be killed in its expected class, with zero invented
  claims on the clean baseline.

A miss is added to the gold set and addressed only through a globally applicable
prompt improvement, rechecked against the whole set. The harnesses and process
rules are documented in [`meta/README.md`](./meta/README.md).

## ✅ Tests

Run the deterministic LEDGER suite and typecheck:

```sh
pnpm exec vitest run evals/ledger
pnpm run eval:ledger:typecheck
```

Include live provider-backed tests:

```sh
LEDGER_LIVE=1 pnpm exec vitest run evals/ledger
```

Live tests require provider credentials; deterministic tests do not.
