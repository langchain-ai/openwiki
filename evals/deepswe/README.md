# DeepSWE OpenWiki evaluation

This harness runs a paired DeepSWE experiment with the same tasks, seed, model,
reasoning effort, attempts, and Harbor environment in both conditions:

- `baseline`: Codex receives only the DeepSWE task and repository.
- `openwiki`: the adapter restores or generates OpenWiki in an isolated clone,
  merges OpenWiki's managed instructions into the repository's root
  `AGENTS.md`, and copies both `AGENTS.md` and `openwiki/` into `/app` before the
  same Codex adapter solves the unchanged DeepSWE task. Codex automatically
  loads root `AGENTS.md`; the harness adds no treatment-only task prompt.

For reproducibility, the harness pins:

- DeepSWE commit `6db64a40f3318d8659238ff34a8cc4b491c49205`
- `harbor[langsmith]==0.20.0`
- `litellm==1.83.14`
- Codex CLI `0.144.6`
- the current OpenWiki checkout, packed locally for each treatment run

## Safety and isolation

DeepSWE's held-out `tests/` and `solution/` live only in a separate verifier
environment. OpenWiki runs against an isolated clone of `/app`, then the harness
copies the generated `openwiki/` and merged root `AGENTS.md` into the agent
repository. Those treatment files are hidden from Git status and excluded from
the verifier patch. Both conditions use the same compatibility path to capture
the base-to-final-HEAD diff for DeepSWE's verifier.

Credentials are injected at runtime by Harbor. They are never written into an
image, command argument, generated wiki, or result summary. Do not enable Harbor's
debug mode for credentialed runs.

Container networking is allowlisted to the package, model, and LangSmith hosts
needed by the run. Docker runs remove only inactive, label-verified Harbor trial
networks; they never perform a global network prune. Parallel agent setup uses a
3x timeout by default, configurable with `--agent-setup-timeout-multiplier`.
If `OPENAI_BASE_URL` uses another gateway, pass its hostname (not a URL) with
`--allow-host gateway.example.com`. The separate verifier environment remains
offline.

## Requirements

- Python 3.12 (Harbor's supported runtime; selected explicitly through `uvx`)
- `uv`/`uvx`
- `pnpm`
- Docker for local runs, or a configured Modal account
- `OPENAI_API_KEY` available in the process environment or an env file passed
  by path with `--env-file`
- `LANGSMITH_API_KEY` available the same way

The project does not add Harbor as a package dependency; `uvx` downloads the
pinned runner and LangSmith extra into its tool cache.

Run the harness tests in that same pinned environment:

```bash
uvx --python 3.12 --from 'harbor[langsmith]==0.20.0' \
  --with 'litellm==1.83.14' \
  python -m unittest discover -s evals/deepswe/tests -p 'test_*.py'
```

## LangSmith datasets, experiments, and traces

Every evaluation uses Harbor's official `langsmith` plugin. Baseline and
OpenWiki jobs share the default `deepswe-openwiki-6db64a40f331` dataset but
create separate experiments named from their Harbor jobs. Ambient experiment
overrides are cleared so the conditions cannot merge accidentally. See the
official
[LangSmith Harbor integration](https://docs.langchain.com/langsmith/harbor-integrations)
for the resulting run and feedback schema.

The local plugin shim sends only bounded verifier rewards as LangSmith feedback,
rounding scores to four decimal places. DeepSWE count metrics remain in local
trial outputs instead of being sent as invalid scores.

Each experiment includes trial phases, verifier/error feedback, and reported
token and cost usage. OpenWiki generation traces are routed to the treatment
experiment. Codex CLI does not emit native LangSmith LLM/tool spans, but Harbor
records its agent phase and ATIF trajectory totals.

Use `--langsmith-dataset NAME` to override the shared dataset. Self-hosted or
multi-workspace LangSmith installations can also use `--langsmith-endpoint URL`
and `--langsmith-workspace-id ID`. Dataset sync and fail-fast behavior are
always enabled so a run cannot silently omit its LangSmith evaluation record.

## Commands

Inspect both commands without downloading tasks, building images, or calling a
model:

```bash
python3 evals/deepswe/run.py paired --n-tasks 2 --dry-run
```

Prepare the pinned DeepSWE checkout and pack the current OpenWiki source:

```bash
python3 evals/deepswe/run.py prepare
```

Run only the baseline:

```bash
source ~/.zshrc && python3 evals/deepswe/run.py baseline \
  --n-tasks 10 \
  --seed 0 \
  --model openai/gpt-5.6-terra \
  --reasoning-effort high
```

Run only the OpenWiki condition:

```bash
source ~/.zshrc && python3 evals/deepswe/run.py openwiki \
  --n-tasks 10 \
  --seed 0 \
  --model openai/gpt-5.6-terra \
  --openwiki-model gpt-5.6-terra \
  --reasoning-effort high
```

Generated task wikis are cached on the host in
`evals/deepswe/.cache/openwiki-wikis`. The key includes the task repository's
base commit, the normalized OpenWiki package contents, and the OpenWiki model,
so unchanged reruns restore the same wiki instead of regenerating it. Use
`--openwiki-cache-dir PATH` to select another persistent cache location. The
first cache-aware run for a commit still generates and populates the cache.
By default, a package update may also reuse an older cache whose validated
`openwiki/.last-update.json` records the exact same task commit and model. Pass
`--no-reuse-compatible-wiki-cache` to disable that lookup. Pass
`--require-openwiki-cache` to fail before any wiki-generation model call on a
cache miss; use this for controlled reruns where wiki Markdown must stay fixed.

Run both paired conditions and summarize them:

```bash
source ~/.zshrc && python3 evals/deepswe/run.py paired \
  --run-name pilot-01 \
  --n-tasks 10 \
  --seed 0 \
  --model openai/gpt-5.6-terra \
  --openwiki-model gpt-5.6-terra \
  --reasoning-effort high
```

Use `--task '<glob>'` to select tasks, `--attempts` for repeated trials,
`--concurrency` for parallel trials, and `--environment modal` for hosted runs.
Seeded sampling selects one exact task list for both paired arms.

### Named OpenWiki task suites

Use `--task-suite` for the exact, reproducible OpenWiki cohorts. A suite
selects all of its members regardless of `--n-tasks` and cannot be combined
with `--task`:

```bash
# Existing fast iteration set: the five Koota tasks
python3 evals/deepswe/run.py paired --task-suite koota-5

# Broader set: the five Koota tasks plus 15 independent repositories
python3 evals/deepswe/run.py paired --task-suite openwiki-20

# Documentation-leverage set: ten cross-surface tasks from independent cohorts
python3 evals/deepswe/run.py paired --task-suite openwiki-doc-leverage-10
```

`koota-5` is the small iteration suite, `openwiki-20` is the broader
cross-repository suite, and `openwiki-doc-leverage-10` contains disjoint tasks
whose ownership and behavior span multiple runtime, serialization, integration,
CLI, SDK, or delivery surfaces. The exact members are pinned in `run.py`.

When the packed OpenWiki checkout exposes `openwiki-retrieval-mcp`, treatment
runs register it inside Codex's isolated home. This capability check keeps the
eval harness runnable against `main` and earlier OpenWiki revisions that do not
yet ship retrieval tools; those revisions still receive their generated wiki
and root `AGENTS.md` without an MCP server.

When available, retrieval provides read-only `search` and `change_surface`
workflows over `/app` and `/app/openwiki`. Local vectors are the default; pass
`--retrieval-embedding-provider openai` to opt into hosted reranking.

If runs already exist, summarize them without invoking Harbor:

```bash
python3 evals/deepswe/run.py summarize --run-name pilot-01 --seed 0
```

## Outputs and interpretation

Harbor writes raw jobs to `evals/deepswe/results/`. The harness writes aggregate
JSON and trial-level CSV files to `evals/deepswe/summaries/`, including:

- binary reward and exception type
- input, cached, and output tokens used by Codex
- Codex cost
- agent and total wall-clock time
- OpenWiki generation wall-clock time

Efficiency should be compared among successful trials as well as across all
trials. A faster failure is not an efficiency improvement.

OpenWiki's current CLI does not expose generation token usage to Harbor's local
summary, so treatment summaries include its wall-clock time but not its tokens
or provider cost. Its LangSmith generation traces in the same experiment provide
generation-token details.

To measure direct treatment overhead after a run, use:

```bash
python3 evals/deepswe/analyze_openwiki_usage.py \
  --job-dir evals/deepswe/results/<openwiki-job>
```

The analyzer separately reports OpenWiki MCP calls, shell reads under
`openwiki/`, serialized tool-call and result characters at four characters per
token, and one automatic inclusion of the managed OpenWiki `AGENTS.md` block.
It also reports token/tool totals after subtracting that estimated direct
overhead. It does not estimate repeated cached-context amplification.
