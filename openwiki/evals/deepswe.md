---
type: Reference
title: DeepSWE Evaluation Harness
description: The Python DeepSWE harness that pairs a baseline Codex run against an OpenWiki-augmented run, its isolation and credential-safety model, LangSmith wiring, and usage analysis.
tags: [evals, deepswe, python, codex, langsmith]
sources:
  - id: openwiki-source-ccd0494cbabafce0bbed2039
    resource: repo://evals/deepswe/analyze_openwiki_usage.py
  - id: openwiki-source-ecc000755b76a6e9fed99e05
    resource: repo://evals/deepswe/deepswe_langsmith.py
  - id: openwiki-source-c45a528335f5cf7306567dc9
    resource: repo://evals/deepswe/README.md
generated: { by: "openwiki/0.3.3", at: "2026-08-22T08:02:55.052Z" }
verified:
  - by: openwiki/0.3.3
    at: 2026-08-22T08:02:55.052Z
---

# DeepSWE Evaluation Harness

The DeepSWE harness measures whether an OpenWiki-augmented repository helps a Codex agent solve software-engineering tasks, by running a paired experiment across two conditions.

## Paired experiment

The harness runs identical tasks, seed, model, reasoning effort, attempts, and Harbor environment across:

- **baseline** — Codex receives only the DeepSWE task and repository.
- **openwiki** — the adapter restores or generates OpenWiki in an isolated clone, merges OpenWiki's managed instructions into the repository root `AGENTS.md`, and copies `AGENTS.md` and `openwiki/` into the app before the unchanged Codex adapter solves the same task, adding no treatment-only task prompt.

For reproducibility the harness pins exact versions (the DeepSWE commit, `harbor`, `litellm`, the Codex CLI, and the local OpenWiki checkout).

## Isolation and credential safety

Held-out DeepSWE tests and solutions live only in a separate **offline verifier** environment. Treatment files (the generated `openwiki/` and merged `AGENTS.md`) are hidden from Git status and excluded from the verifier patch, so both conditions capture the same base-to-final-HEAD diff.

Credentials are injected at runtime by Harbor and are **never** written into an image, command argument, generated wiki, or result summary. Container networking is allowlisted to only the package, model, and LangSmith hosts.

## LangSmith wiring and usage analysis

`DeepSWELangSmithPlugin` sends only bounded DeepSWE rewards and swallows feedback request failures with a warning, so telemetry problems never abort a trial.

`analyze_openwiki_usage.py` estimates direct OpenWiki retrieval token overhead in Codex traces with a simple, reproducible rule of one token per four characters, deliberately not modeling repeated context-window charges or tokenizer specifics.

The TypeScript grounding harness is documented in [ledger.md](ledger.md).
