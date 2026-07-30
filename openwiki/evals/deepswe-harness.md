---
type: Evaluation harness
title: DeepSWE OpenWiki evaluation harness
description: Paired DeepSWE benchmark harness that compares a baseline Codex agent against an OpenWiki-augmented Codex agent to measure documentation leverage. Documents the run.py CLI, paired conditions, task suites, wiki caching, LangSmith integration, Codex adapters, and the direct-overhead analyzer.
tags: [evals, deepswe, harbor, codex, langsmith, benchmark]
---

# DeepSWE OpenWiki evaluation harness

The `evals/deepswe/` directory contains a Python harness that runs a **paired DeepSWE experiment** to measure whether OpenWiki-generated documentation helps a coding agent solve real software-engineering tasks. It is pinned to a fixed DeepSWE benchmark revision and orchestrates two conditions through Harbor with identical task sampling, model, seed, reasoning effort, and environment, then summarizes the results.

The treatment condition generates its wiki through OpenWiki's normal documentation agent (see [Agent workflow](../agent/workflow.md)) in an isolated clone, then feeds the resulting `openwiki/` directory and merged `AGENTS.md` into a Codex agent that solves the task. This makes the harness a downstream consumer of the [Agent workflow](../agent/workflow.md), and the generated wiki's quality directly affects the measured documentation leverage.

## What it measures

The harness compares two conditions over the same DeepSWE tasks:

- **`baseline`**: a Codex agent receives only the DeepSWE task and repository.
- **`openwiki`**: the adapter restores or generates an OpenWiki wiki in an isolated clone, merges OpenWiki's managed instructions into the repository's root `AGENTS.md`, copies both `AGENTS.md` and `openwiki/` into `/app`, then runs the same Codex agent against the unchanged task. Codex automatically loads root `AGENTS.md`; the harness adds no treatment-only task prompt.

Both conditions capture the base-to-final-HEAD diff for DeepSWE's verifier through the same compatibility path. Generated wikis and the merged `AGENTS.md` are hidden from Git status and excluded from the verifier patch so the treatment files do not leak into the scored diff.

## Pinned versions

For reproducibility, `evals/deepswe/run.py` pins:

- DeepSWE commit `6db64a40f3318d8659238ff34a8cc4b491c49205`
- `harbor[langsmith]==0.20.0` (installed on the fly via `uvx`, not a package dependency)
- `litellm==1.83.14`
- Codex CLI `0.144.6`
- the current OpenWiki checkout, packed locally for each treatment run

Requirements: Python 3.12 (selected explicitly through `uvx`), `uv`/`uvx`, `pnpm`, Docker for local runs or a configured Modal account, plus `OPENAI_API_KEY` and `LANGSMITH_API_KEY` in the process environment or an `--env-file`.

## Commands

`evals/deepswe/run.py` exposes four subcommands:

- `prepare` — fetch the pinned DeepSWE checkout and pack the current OpenWiki source into a tarball for treatment runs.
- `baseline` — run only the baseline condition.
- `openwiki` — run only the OpenWiki-augmented condition.
- `paired` — run both conditions with the same seeded task sampling and summarize them.
- `summarize` — re-summarize existing Harbor results without invoking the runner.
- `--dry-run` (on `paired`) — inspect both commands without downloading tasks, building images, or calling a model.

Key options include `--n-tasks`, `--seed`, `--model` (the coding-agent model, default `openai/gpt-5.6-terra`), `--openwiki-model` (the wiki-generation model, default `gpt-5.6-terra`), `--reasoning-effort`, `--attempts`, `--concurrency`, `--environment modal` for hosted runs, `--task '<glob>'` to select tasks, and `--task-suite` for named reproducible cohorts.

## Named task suites

`run.py` defines three pinned task suites in `TASK_SUITES`:

| Suite                      | Members                                                                                | Purpose                         |
| -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| `koota-5`                  | 5 Koota tasks                                                                          | Small iteration set.            |
| `openwiki-20`              | 5 Koota tasks + 15 independent repositories                                            | Broader cross-repository suite. |
| `openwiki-doc-leverage-10` | 10 disjoint tasks spanning runtime/serialization/integration/CLI/SDK/delivery surfaces | Documentation-leverage set.     |

`--task-suite` selects all members regardless of `--n-tasks` and cannot be combined with `--task`. Exact members are pinned in `run.py`.

## Wiki caching

Generated task wikis are cached on the host under `evals/deepswe/.cache/openwiki-wikis` (override with `--openwiki-cache-dir`). The cache key includes the task repository's base commit, the normalized OpenWiki package contents, and the OpenWiki model, so unchanged reruns restore the same wiki instead of regenerating it. Cache-related flags:

- `--no-reuse-compatible-wiki-cache` — disable reusing an older cache whose `openwiki/.last-update.json` matches the exact task commit and model.
- `--require-openwiki-cache` — fail before any wiki-generation model call on a cache miss; use this for controlled reruns where wiki Markdown must stay fixed.

The cache archive is validated for path safety (no absolute paths or `..` traversal), member count, and uncompressed size before it is accepted.

## LangSmith integration

Every evaluation uses Harbor's official `langsmith` plugin. Baseline and OpenWiki jobs share the default `deepswe-openwiki-6db64a40f331` dataset but create separate experiments named from their Harbor jobs; ambient experiment overrides are cleared so the conditions cannot merge accidentally. Override the dataset with `--langsmith-dataset`; self-hosted or multi-workspace installations can use `--langsmith-endpoint` (embedded credentials are rejected) and `--langsmith-workspace-id`. Dataset sync and fail-fast behavior are always enabled.

`evals/deepswe/deepswe_langsmith.py` ships `DeepSWELangSmithPlugin`, a subclass that sends only bounded verifier rewards as LangSmith feedback (rounded to four decimals) and swallows HTTP errors so a telemetry publish failure never aborts a trial. DeepSWE count metrics stay in local trial outputs instead of being sent as invalid scores.

## Codex adapters and retrieval MCP

`evals/deepswe/openwiki_codex.py` implements Harbor Codex adapters for both conditions. For the OpenWiki condition it: packs the OpenWiki source with a normalized digest (stable across tar ownership/timestamps), restores or generates the wiki in an isolated clone, merges the managed `AGENTS.md` block (`<!-- OPENWIKI:START -->` / `<!-- OPENWIKI:END -->`), and copies the treatment files into `/app`.

When the packed OpenWiki checkout exposes `openwiki-retrieval-mcp`, treatment runs register it inside Codex's isolated home. This capability check keeps the harness runnable against `main` and earlier OpenWiki revisions that do not yet ship retrieval tools; those revisions still receive their generated wiki and root `AGENTS.md` without an MCP server. When available, retrieval provides read-only `search` and `change_surface` workflows over `/app` and `/app/openwiki`. Local vectors are the default; pass `--retrieval-embedding-provider openai` to opt into hosted reranking.

## Direct-overhead analyzer

`evals/deepswe/analyze_openwiki_usage.py` measures direct OpenWiki retrieval overhead in Codex DeepSWE traces after a run:

```bash
python3 evals/deepswe/analyze_openwiki_usage.py \
  --job-dir evals/deepswe/results/<openwiki-job>
```

It reports OpenWiki MCP calls, shell reads under `openwiki/`, serialized tool-call and result characters at four characters per token, and one automatic inclusion of the managed `AGENTS.md` block, plus totals after subtracting that estimated direct overhead. It does not estimate repeated cached-context amplification. OpenWiki's CLI does not expose generation token usage to Harbor's local summary, so treatment summaries include wiki-generation wall-clock time but not its tokens or provider cost; LangSmith generation traces in the same experiment provide those details.

## Safety and isolation

- DeepSWE's held-out `tests/` and `solution/` live only in a separate verifier environment.
- Credentials are injected at runtime by Harbor and are never written into images, command arguments, generated wikis, or result summaries. Do not enable Harbor's debug mode for credentialed runs.
- Container networking is allowlisted to the package, model, and LangSmith hosts. If `OPENAI_BASE_URL` uses another gateway, pass its hostname with `--allow-host`. Docker cleanup removes only inactive, label-verified Harbor trial networks — never a global prune. The verifier environment remains offline.

## Outputs

Harbor writes raw jobs to `evals/deepswe/results/`. The harness writes aggregate JSON and trial-level CSV files to `evals/deepswe/summaries/`, with columns: condition, task name, trial name, binary reward, exception type, input/cache/output tokens, Codex cost, agent and total wall-clock time, and OpenWiki generation wall-clock time. Efficiency should be compared among successful trials as well as across all trials — a faster failure is not an efficiency improvement.

## Testing the harness

Run the pinned test suite:

```bash
uvx --python 3.12 --from 'harbor[langsmith]==0.20.0' \
  --with 'litellm==1.83.14' \
  python -m unittest discover -s evals/deepswe/tests -p 'test_*.py'
```

`evals/deepswe/tests/test_run.py` covers LangSmith feedback rounding/error handling, OpenWiki install behavior, treatment patch capture, seeded task selection, named suite composition, wiki cache key stability and archive safety, Docker network cleanup, and trial aggregation. `evals/deepswe/tests/test_analyze_openwiki_usage.py` covers tool-call/file-system classification, trace pairing, direct-overhead counting, and overhead subtraction.

## Source map

- `evals/deepswe/README.md` — user-facing harness documentation and command examples.
- `evals/deepswe/run.py` — prepare/baseline/openwiki/paired/summarize CLI, task suites, Harbor argument assembly, credential checks, Docker network cleanup, and trial aggregation.
- `evals/deepswe/openwiki_codex.py` — Harbor Codex adapters, OpenWiki packaging, wiki generation/restore, `AGENTS.md` merge, cache schema, and retrieval MCP registration.
- `evals/deepswe/deepswe_langsmith.py` — `DeepSWELangSmithPlugin` feedback subclass.
- `evals/deepswe/analyze_openwiki_usage.py` — post-run direct-overhead analyzer.
- `evals/deepswe/tests/test_run.py`, `evals/deepswe/tests/test_analyze_openwiki_usage.py` — harness tests.
