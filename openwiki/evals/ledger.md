---
type: Reference
title: LEDGER Evaluation Harness
description: The TypeScript LEDGER harness that replays Git checkpoints, runs OpenWiki, and scores each frozen wiki's factual claims as supported, stale, invented, or unverified.
tags: [evals, ledger, grounding, scoring, benchmark]
sources:
  - id: openwiki-source-949522a1dfce74920badb2b6
    resource: repo://evals/ledger/README.md
  - id: openwiki-source-8fe49b679bb29b6d5403548c
    resource: repo://evals/ledger/reevaluate.ts
  - id: openwiki-source-bdd14aa92ae4a01628e282cd
    resource: repo://evals/ledger/run.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-22T08:02:55.052Z" }
verified:
  - by: openwiki/0.3.3
    at: 2026-08-22T08:02:55.052Z
---

# LEDGER Evaluation Harness

LEDGER (Longitudinal Evaluation of Documentation Grounding, Evolution, and Revision) is a source-grounded framework that replays Git checkpoints, runs OpenWiki at each, and evaluates whether each frozen wiki snapshot's factual claims remain accurate as the source evolves.

## Claim states

At each checkpoint the evaluator extracts atomic factual claims from every generated Markdown document — ignoring navigation, opinions, instructions, and wiki self-description — and classifies each current-tense claim into one of four states:

| State        | Meaning                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| `supported`  | Current source establishes the claim                                       |
| `stale`      | Current source contradicts it and history establishes it was formerly true |
| `invented`   | Current source contradicts it and history does not establish it            |
| `unverified` | Supplied evidence neither establishes nor contradicts it                   |

All four rates share the count of current claims as their denominator, and each checkpoint **recomputes** the partition from the entire current wiki rather than as a delta or average.

## Evaluation pipeline

```mermaid
flowchart TD
    Md["all generated Markdown"] --> Extract["classify text units, extract claims with exact quotes"]
    Extract --> Dedup["remove normalized duplicates"]
    Dedup --> Map["match to evaluator-only evidence-map concepts"]
    Map --> Resolve["resolve to raw source"]
    Resolve --> Label{"supported / contradicted / not addressed"}
    Label -- contradicted --> Hist{"formerly true?"}
    Hist -- yes --> Stale["stale"]
    Hist -- no --> Invented["invented"]
    Label -- "not addressed" --> Unv["unverified"]
```

_The claim evaluation pipeline._

## Running

`run.ts` is the harness entrypoint: it resolves config, loads the benchmark, prepares a run directory, drives the System Under Test and the model evaluation backend through `runBenchmark`, and finalizes the run, persisting a failure audit if the run throws. The system under test and the evaluator are **separate** backends — an `OpenWikiSystem` produces the wiki while a `ModelEvaluationBackend` scores it, each configured with its own model id.

`reevaluate.ts` re-scores a completed run **without** invoking the System Under Test, but still loads the benchmark because source is the ground truth read at each checkpoint's commit, and it persists a fully independent auditable result.

Both entrypoints stamp the start timestamp once and thread it into the run so the result is otherwise a pure function of its inputs, and each guards direct invocation so importing the module in a test does not run it.

The companion Python harness is documented in [deepswe.md](deepswe.md).
