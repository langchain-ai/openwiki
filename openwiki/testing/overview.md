---
type: testing-guide
title: Testing Guide
description: How the OpenWiki Vitest suite is laid out, the pnpm test pipeline, coverage configuration, test discovery, per-subsystem test mappings, and the evaluation harnesses (LEDGER and DeepSWE).
tags: [testing, vitest, coverage, ink-testing-library, ci, developer-workflow, evaluation]
verified:
  - by: openwiki/0.4.0
    at: 2026-08-26T17:22:53.864Z
sources:
  - id: openwiki-source-c45a528335f5cf7306567dc9
    resource: repo://evals/deepswe/README.md
  - id: openwiki-source-a0ae0064681def9d035f11b2
    resource: repo://evals/deepswe/run.py
  - id: openwiki-source-6ad47cf13ce77f0839b358ec
    resource: repo://evals/deepswe/tests/test_run.py
  - id: openwiki-source-1613bad502de3edacc6bd53f
    resource: repo://evals/ledger/benchmark/benchmark.ts
  - id: openwiki-source-76e853181e8d02ef777bc0fe
    resource: repo://evals/ledger/benchmark/source-repo.ts
  - id: openwiki-source-d7466a5cc8e2ee56e79afaf9
    resource: repo://evals/ledger/benchmarks/calc/benchmark.json
  - id: openwiki-source-949522a1dfce74920badb2b6
    resource: repo://evals/ledger/README.md
  - id: openwiki-source-8fe49b679bb29b6d5403548c
    resource: repo://evals/ledger/reevaluate.ts
  - id: openwiki-source-bdd14aa92ae4a01628e282cd
    resource: repo://evals/ledger/run.ts
  - id: openwiki-source-9ed6b8f20e8834ac914a4c18
    resource: repo://evals/ledger/run/report.test.ts
  - id: openwiki-source-2dc719639f40452478188d6b
    resource: repo://evals/ledger/system/openwiki-system.ts
  - id: openwiki-source-33844b1c2c98eca457fd6142
    resource: repo://evals/ledger/tsconfig.json
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-e25b880bed632d812ac9f1a8
    resource: repo://test/agent/gemini-enterprise-claude.e2e.test.ts
  - id: openwiki-source-ec5a58d1a89689ead79b8150
    resource: repo://test/agent/repository-runner.test.ts
  - id: openwiki-source-60f74aa845439889d9b5e391
    resource: repo://test/claims/brains/code/store.test.ts
  - id: openwiki-source-07638dd09c03aa66a99013cf
    resource: repo://test/claims/core/mutations.test.ts
  - id: openwiki-source-b29e22b2bea9905b27e8e8e8
    resource: repo://test/claims/evidence/repository/resolver.test.ts
  - id: openwiki-source-61040321732e97cebb914633
    resource: repo://test/cli/components/markdown.test.tsx
  - id: openwiki-source-7813b7a34b04f73e9967e3c9
    resource: repo://test/connectors/fetch-with-resilience.test.ts
  - id: openwiki-source-3644b45ff9c47926aa74026e
    resource: repo://test/connectors/mcp-client.test.ts
  - id: openwiki-source-121d84750cf9c5f503741f20
    resource: repo://test/connectors/sources/git-repo.test.ts
  - id: openwiki-source-903a325df75151b40ef13a4b
    resource: repo://test/connectors/sources/slack.test.ts
  - id: openwiki-source-cfc15a67b4c02c45974332dc
    resource: repo://test/generation/page-jobs.test.ts
  - id: openwiki-source-77febf5d49f26cc2405db8dd
    resource: repo://test/generation/repository-run.test.ts
  - id: openwiki-source-5c504746431185b33e3c7f39
    resource: repo://test/mermaid/dom-shim.test.ts
  - id: openwiki-source-2b788920f8a5c721b3430f6c
    resource: repo://test/openwiki-home.test.ts
  - id: openwiki-source-fbadcd8591b65031efaaedce
    resource: repo://vitest.config.ts
generated: {by: "openwiki/0.4.0", at: "2026-08-26T17:22:53.864Z"}
---

# Testing Guide

OpenWiki is validated by a single [Vitest](https://vitest.dev) suite under `test/`.
The suite is fast, mostly offline (external services and SDKs are stubbed), and
mirrors the `src/` tree directory-for-directory so that the tests for a subsystem
live at the matching path. This page explains the tooling, the full `pnpm test`
pipeline, and — for each subsystem — the narrowest command that proves a change
while preserving complete failure output.

A separate pair of **evaluation harnesses** live under `evals/` and are not part
of the Vitest suite: LEDGER measures documentation grounding over time, and
DeepSWE measures whether a generated OpenWiki helps a coding agent on real tasks.
They are described in their own section below.

## Tooling

- **Test runner: Vitest.** `vitest` (and `@vitest/coverage-v8`) are dev
  dependencies; there is no separate framework. Tests import `describe`,
  `expect`, `test`, `vi`, and the `beforeEach`/`afterEach` hooks directly from
  `vitest`.
- **Ink component tests: ink-testing-library.** Terminal UI written with Ink is
  exercised by rendering React components with `render` from
  `ink-testing-library` and asserting on the rendered frame (`lastFrame()`).
  These tests are the `.tsx` files under `test/cli/components/` and
  `test/setup/credentials/`.
- **No global config beyond `vitest.config.ts`.** Test discovery keeps Vitest's
  defaults; the only tuning is one discovery exclusion and the coverage block
  (see below).

Tests import source modules directly by relative path (for example
`../../src/agent/index.ts`), so a source module can be unit-tested without
building `dist/` first. `tsx` runs the CLI in development (`pnpm dev`), but the
test suite itself runs through Vitest's own transform.

## The `pnpm test` pipeline

`pnpm test` is not just the unit run — it is a three-stage gate that must pass in
order:

```mermaid
flowchart TD
  A["pnpm test"] --> B["typecheck"]
  B --> C["build"]
  C --> D["coverage"]
  B -.-> B1["tsc --noEmit tsconfig.json + tsconfig.client.json"]
  C -.-> C1["tsc project build + copy-visualize-assets"]
  D -.-> D1["vitest run --coverage"]
```

The `pnpm test` gate: typecheck, then build, then the coverage run.

1. **`typecheck`** runs `tsc --noEmit` against both the server project
   (`tsconfig.json`) and the browser/client project (`tsconfig.client.json`).
2. **`build`** compiles both TypeScript projects and copies the visualize
   client assets.
3. **`coverage`** runs `vitest run --coverage`, which executes every test and
   produces a coverage report.

When iterating locally you usually do **not** want the whole gate. Run Vitest
directly (`pnpm exec vitest run <path-or-pattern>`) to execute a focused slice,
then run `pnpm test` once before proposing the change so typecheck, build, and
coverage all agree.

## Coverage configuration

Coverage uses the V8 provider with `all: true` and an explicit
`include: ["src/**/*.{ts,tsx}"]`. `all: true` plus the explicit include makes the
report cover the **entire** `src` tree, so a source file that no test imports yet
appears as 0% rather than being silently omitted from the denominator.

A small set of files are deliberately excluded from coverage because they emit no
runtime JavaScript or can only run in an environment a Node unit test cannot
drive: `*.d.ts`, pure `types.ts` declaration modules, the `telemetry/index.ts`
re-export barrel, the browser-only `visualize/client.ts`, and the Ink keyboard
state machine `setup/credentials/use-init-setup.ts`. In each excluded case the
extractable pure logic lives in a separate, tested module (for example
`visualize/client-lib.ts`, or `steps.ts`/`format.ts`/`persistence.ts` for the
setup wizard), so new logic belongs in those tested modules rather than in the
excluded glue. The coverage reporters are `text`, `text-summary`, `html`,
`json-summary`, and `lcov`.

## Test discovery

Vitest keeps its default discovery globs and adds exactly one exclusion:
`**/benchmarks/*/repo/**`. A LEDGER benchmark under
`evals/ledger/benchmarks/` (the checked-in `calc` and `taskflow` benchmarks) can
rebuild an upstream project's source tree into a `repo/` directory that carries
that project's own `*.test.ts` files — for example `evals/ledger/benchmarks/taskflow/repo/surface.test.ts`
belongs to the fixture under test, not to OpenWiki. The exclusion guarantees that
a benchmark whose `repo/` happens to be present on disk cannot pollute this
project's suite. The pattern is path-agnostic (`**/benchmarks/*/repo/**`), so it
still applies even though the exclusion comment in `vitest.config.ts` itself
references the older `evals/keb/` path.

## Test layout maps to source subsystems

`test/` mirrors `src/`. To find (or add) tests for a subsystem, go to the
matching path. The most important mappings:

| Test directory                                                                                                                                            | Source subsystem it validates                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `test/agent/`                                                                                                                                             | `src/agent/` — model creation, middleware, prompts, streaming, redaction, the repository runner               |
| `test/claims/`                                                                                                                                            | `src/claims/` — grounded-claim core, the code claim brain, and evidence resolution                            |
| `test/connectors/`                                                                                                                                        | `src/connectors/` — connector config, resilient fetch, MCP client/runtime, and per-source ingestion           |
| `test/generation/`                                                                                                                                        | `src/generation/` — repository planning, page jobs, and run-state persistence                                 |
| `test/integrations/`                                                                                                                                      | `src/integrations/` — host installers, config adapters, the MCP server, and packaged skill/protocol contracts |
| `test/cli/`                                                                                                                                               | `src/cli/` — CLI wiring and Ink components                                                                    |
| `test/setup/`                                                                                                                                             | `src/setup/` — the credentials setup wizard                                                                   |
| `test/config/`, `test/okf/`, `test/mermaid/`, `test/visualize/`, `test/scheduling/`, `test/telemetry/`, `test/auth/`, `test/ingestion/`, `test/platform/` | the matching `src/` subsystem                                                                                 |

Related architecture and subsystem pages: the
[source map](../architecture/source-map.md),
[grounded claims](../concepts/grounded-claims.md),
[coding-agent integrations](../integrations/coding-agents.md), and the
[repository generation workflow](../workflows/repository-generation.md).

### Claims: nested layout

`test/claims/` splits by the claims subsystem's own internal boundaries:
`test/claims/core/` (the resolver-agnostic mutation and error model, e.g.
`applyClaimOperations`/`cloneClaims`), `test/claims/brains/code/` (the code claim
brain — paths, preflight, runtime, session, store), and
`test/claims/evidence/repository/` (repository evidence resource parsing and the
resolver). This mirrors the `src/claims/` split between core, brain, and evidence
concerns.

### Connectors: shared machinery vs. per-source

`test/connectors/` keeps cross-cutting machinery at the top level
(`connector-config*`, `fetch-with-resilience`, `mcp-client`, `mcp-runtime`,
`raw-connector-tools`, `tools`) and puts each individual source under
`test/connectors/sources/` (git-repo, gmail, hackernews, mcp, slack, web-search,
x, langsmith, custom-mcp). A source's pure logic is often private and only
observable through its `ingest()` entry point, so those tests point `$HOME` at a
throwaway temp directory, feed controlled API responses through a stubbed
`fetch`, and assert on the request the connector builds and the normalized raw
dump it writes to disk — no real network call or OAuth token is involved. To add
a new connector, use the `write-connector` skill and add a matching test under
`test/connectors/sources/`.

## Testing patterns you will reuse

- **Dependency injection via `vi.mock` + `vi.hoisted`.** Failure-path tests
  wrap a real module with `vi.mock(..., importOriginal)` and use a hoisted
  counter to inject a failure on the Nth call while otherwise delegating to the
  real implementation. `test/generation/repository-run.test.ts`, for example,
  injects metadata-write and run-state write/removal failures this way to prove
  the runner's recovery behavior.
- **Real filesystem in a temp dir.** Tests that exercise on-disk behavior create
  an OS temp directory (`mkdtemp`), redirect `$HOME`/`USERPROFILE` or
  `OPENWIKI_CONFIG_DIR` into it, and clean up in `afterEach`. This keeps the
  suite hermetic without mocking `fs`.
- **Ink render assertions.** Component tests render with `ink-testing-library`
  and assert on `lastFrame()`, stripping ANSI first (via the shared
  `test/cli/components/ansi.ts` helper) so assertions match plain text.
- **DOM shim for Mermaid.** Tests that touch Mermaid validation call
  `ensureDomGlobals()` from `src/mermaid/dom-shim.ts` to install jsdom's
  window/document globals.

## Evaluation harnesses

The two evaluation suites under `evals/` are **separate from the Vitest unit
suite**. They measure OpenWiki's output quality end-to-end, not individual source
modules, and each has its own runner and language/toolchain.

```mermaid
flowchart TD
  E["evals/"] --> L["LEDGER  evals/ledger/"]
  E --> D["DeepSWE  evals/deepswe/"]
  L --> L1["pnpm run eval:ledger  (tsx evals/ledger/run.ts)"]
  D --> D1["python3 evals/deepswe/run.py paired"]
  L1 --> L2["replay Git checkpoints, run OpenWiki, score claim states"]
  D1 --> D2["baseline Codex vs Codex plus OpenWiki on DeepSWE tasks"]
```

The two eval suites under `evals/`, their entry points, and what each measures.

### LEDGER

LEDGER (Longitudinal Evaluation of Documentation Grounding, Evolution, and
Revision) lives under `evals/ledger/` and runs through `pnpm run eval:ledger`
(`tsx evals/ledger/run.ts`). It replays a benchmark's Git checkpoints, runs
OpenWiki against each frozen source snapshot, and evaluates the resulting wiki for
claim states. Every current-tense factual claim ends in exactly one state:
`supported` (current source establishes it), `stale` (current source contradicts
it but it was formerly true), `invented` (the CLI prints this as `hallucinated`;
current source contradicts and history never established it), or `unverified`
(the supplied evidence neither establishes nor contradicts it). The run-level
LEDGER score is opportunity-weighted claim health: `supported / all current
claims across checkpoints`.

The LEDGER harness drives OpenWiki through its real `runOpenWikiAgent` entrypoint
with `outputMode: "repository"`, so an `init` runs at the first checkpoint and an
`update` at each later one, with change detection driven purely by the real
source deltas between checkpoints. A `ModelEvaluationBackend` performs the
claim extraction and grounding judgments.

Each benchmark is a directory under `evals/ledger/benchmarks/` containing a
`benchmark.json` manifest (name, difficulty, an ordered list of pinned checkpoint
commits, and an optional reviewer-provided semantic evidence map) plus a
`repo.bundle` carrying the benchmark's Git history. The checked-in benchmarks are
`evals/ledger/benchmarks/calc/` and `evals/ledger/benchmarks/taskflow/`. The
manifest's `sourceRepo` (e.g. `"./repo"`) points at a gitignored working tree
that `ensureSourceRepoAvailable` reconstructs from `repo.bundle` when a fresh
checkout leaves it absent — this is the reconstruction that creates the `repo/`
subdirectory the Vitest discovery exclusion guards against.

LEDGER is TypeScript with its own `evals/ledger/tsconfig.json` (extending the
root `tsconfig.json` with `noEmit`) and a dedicated typecheck script
`pnpm run eval:ledger:typecheck`. It also has a `reevaluate` mode
(`pnpm run eval:ledger:reevaluate`, `evals/ledger/reevaluate.ts`) that re-scores a
saved run without invoking OpenWiki again, and its own Vitest tests under
`evals/ledger/` (run with `pnpm exec vitest run evals/ledger`). The normal suite
is offline and substitutes deterministic evaluator and system implementations;
live evaluator calibration is opt-in through `LEDGER_LIVE=1`.

### DeepSWE

DeepSWE lives under `evals/deepswe/` and is a **Python** paired
baseline-vs-OpenWiki harness (`python3 evals/deepswe/run.py`). It runs Codex on
DeepSWE coding tasks under two conditions with the same tasks, seed, model,
reasoning effort, attempts, and Harbor environment:

- `baseline`: Codex receives only the DeepSWE task and repository.
- `openwiki`: the adapter restores or generates an OpenWiki in an isolated clone,
  merges OpenWiki's managed instructions into the repository's root `AGENTS.md`,
  and copies both `AGENTS.md` and `openwiki/` into `/app` before the same Codex
  adapter solves the unchanged DeepSWE task.

The `run.py` CLI exposes `prepare`, `baseline`, `openwiki`, `paired`, and
`summarize` subcommands. `paired` runs both arms and summarizes them. The harness
pins reproducibility artifacts — the DeepSWE commit, `harbor[langsmith]`,
`litellm`, the Codex CLI version, and a locally packed copy of the current
OpenWiki checkout — and records results to LangSmith via Harbor's official
`langsmith` plugin (baseline and OpenWiki share a dataset but create separate
experiments). Its own tests are Python `unittest` tests under
`evals/deepswe/tests/`, run in the pinned Harbor environment rather than through
Vitest. Because it is Python, it has no role in `pnpm test` or the Vitest
coverage run.

## Choosing the narrowest validation per subsystem

Run the smallest slice that would fail if your change is wrong, then run the full
`pnpm test` gate before finishing. Use `pnpm exec vitest run <path>` to scope by
file or directory, or `-t "<name>"` to scope by test name. For evaluation
harness changes, use the harness-specific commands above (`pnpm run eval:ledger`,
`python3 evals/deepswe/run.py …`) rather than the unit suite.