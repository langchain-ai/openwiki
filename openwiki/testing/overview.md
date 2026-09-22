---
type: testing-guide
title: Testing Guide
description: How the OpenWiki test suite is laid out, the vitest and ink-testing-library tooling it uses, the pnpm test pipeline, how to scope the narrowest validation that proves a change per subsystem (including the repository-runner parallel-worker and skip/restore tests), and where the separate evals/ledger and evals/deepswe evaluation suites live.
tags: [testing, vitest, coverage, ink-testing-library, ci, developer-workflow, evals]
sources:
  - id: openwiki-source-c45a528335f5cf7306567dc9
    resource: repo://evals/deepswe/README.md
  - id: openwiki-source-6ad47cf13ce77f0839b358ec
    resource: repo://evals/deepswe/tests/test_run.py
  - id: openwiki-source-949522a1dfce74920badb2b6
    resource: repo://evals/ledger/README.md
  - id: openwiki-source-bdd14aa92ae4a01628e282cd
    resource: repo://evals/ledger/run.ts
  - id: openwiki-source-cbc766890230b3eb91e4f047
    resource: repo://evals/ledger/run/runner.test.ts
  - id: openwiki-source-33844b1c2c98eca457fd6142
    resource: repo://evals/ledger/tsconfig.json
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-6cb3236b8c1412a26d832fcf
    resource: repo://src/agent/repository-runner.ts
  - id: openwiki-source-69abc6f0f641147820a274bc
    resource: repo://src/agent/utils.ts
  - id: openwiki-source-410e7efbe6dee8c4d43e9b4d
    resource: repo://src/integrations/core/protocol.ts
  - id: openwiki-source-58835b77ce38a0dd1fed8d09
    resource: repo://src/integrations/core/session-manager.ts
  - id: openwiki-source-eab9328975981f427c4218d0
    resource: repo://src/integrations/mcp/server.ts
  - id: openwiki-source-6cc520117b0eb03bfd36a7c8
    resource: repo://test/agent/frontmatter-validator.test.ts
  - id: openwiki-source-e25b880bed632d812ac9f1a8
    resource: repo://test/agent/gemini-enterprise-claude.e2e.test.ts
  - id: openwiki-source-8826337e8c8799af4371a0e5
    resource: repo://test/agent/index-middleware.test.ts
  - id: openwiki-source-d5f8bf1d374d40091b048814
    resource: repo://test/agent/repository-prompts.test.ts
  - id: openwiki-source-ec5a58d1a89689ead79b8150
    resource: repo://test/agent/repository-runner.test.ts
  - id: openwiki-source-b6fe810a0cf7dea1a9e0eb8b
    resource: repo://test/agent/repository-source-fingerprint.test.ts
  - id: openwiki-source-d485c898eb60ebb173072eab
    resource: repo://test/agent/stream-redaction.test.ts
  - id: openwiki-source-f1b33b05f136bc4ed936d51d
    resource: repo://test/agent/update-noop.test.ts
  - id: openwiki-source-76662ef8eda6e868acc8fb1a
    resource: repo://test/agent/vertex-surface.test.ts
  - id: openwiki-source-10e644b1d94ea2cd8435efb2
    resource: repo://test/agent/wiki-finalizer.test.ts
  - id: openwiki-source-60f74aa845439889d9b5e391
    resource: repo://test/claims/brains/code/store.test.ts
  - id: openwiki-source-07638dd09c03aa66a99013cf
    resource: repo://test/claims/core/mutations.test.ts
  - id: openwiki-source-b29e22b2bea9905b27e8e8e8
    resource: repo://test/claims/evidence/repository/resolver.test.ts
  - id: openwiki-source-61040321732e97cebb914633
    resource: repo://test/cli/components/markdown.test.tsx
  - id: openwiki-source-f5f9f9512cc2874a9127f6e1
    resource: repo://test/cli/diagnostics/error-diagnostics.test.ts
  - id: openwiki-source-e0c8b1fbf566b4e3dd216c3d
    resource: repo://test/cli/run-log/activity.test.ts
  - id: openwiki-source-f403159d398704a89ba45e50
    resource: repo://test/cli/run-log/progress.test.ts
  - id: openwiki-source-062e06dd4b088661ac6d6bda
    resource: repo://test/cli/run-log/reducer.test.ts
  - id: openwiki-source-460bc4cf555b48df28242d69
    resource: repo://test/cli/run-log/summary.test.ts
  - id: openwiki-source-b4119ab1b612205e134e2a39
    resource: repo://test/cli/run-log/tool-input.test.ts
  - id: openwiki-source-5fc87e9739dab52c4e447110
    resource: repo://test/config/constants.test.ts
  - id: openwiki-source-507f854511667d512b3fa0ee
    resource: repo://test/config/env.test.ts
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
  - id: openwiki-source-328aca3cf4070aa49cc954a5
    resource: repo://test/generation/page-manifest.test.ts
  - id: openwiki-source-77febf5d49f26cc2405db8dd
    resource: repo://test/generation/repository-run.test.ts
  - id: openwiki-source-1adcdcd6832678e0e848f408
    resource: repo://test/generation/run-state.test.ts
  - id: openwiki-source-a0cec66bd3bed0c13c668ff0
    resource: repo://test/git-repo-connector.test.ts
  - id: openwiki-source-caa199fea0a0f4f89151a0c8
    resource: repo://test/ingest-all-connectors.test.ts
  - id: openwiki-source-224b03172757408e1b558fa7
    resource: repo://test/ingestion/code-mode.test.ts
  - id: openwiki-source-1830eb3a15f412bf58d08bef
    resource: repo://test/integrations/mcp-server.test.ts
  - id: openwiki-source-7586182fa3a8278fbe99d348
    resource: repo://test/integrations/protocol.test.ts
  - id: openwiki-source-d1d0d34cd042b7cd70476a68
    resource: repo://test/integrations/session-manager.test.ts
  - id: openwiki-source-5c504746431185b33e3c7f39
    resource: repo://test/mermaid/dom-shim.test.ts
  - id: openwiki-source-43240ab040106a6f63192176
    resource: repo://test/okf/frontmatter.test.ts
  - id: openwiki-source-7ab91e61f234ef2c4b6b6258
    resource: repo://test/openrouter-debug-fetch.test.ts
  - id: openwiki-source-2b788920f8a5c721b3430f6c
    resource: repo://test/openwiki-home.test.ts
  - id: openwiki-source-e3be493bc871948f42420690
    resource: repo://test/visualize/client-interaction.test.ts
  - id: openwiki-source-1904eaebd82125a3a3881dac
    resource: repo://test/visualize/page.test.ts
  - id: openwiki-source-dbb4558a2e1f7159813c79c5
    resource: repo://test/x-connector-stream-isolation.test.ts
  - id: openwiki-source-98d5ddb014a0fd4d678f6f2a
    resource: repo://tsconfig.json
  - id: openwiki-source-fbadcd8591b65031efaaedce
    resource: repo://vitest.config.ts
generated: { by: "openwiki/0.5.2", at: "2026-09-22T08:09:45.637Z" }
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T08:09:45.637Z
---

# Testing Guide

OpenWiki is validated by a single [Vitest](https://vitest.dev) suite under `test/`.
The suite is fast, mostly offline (external services and SDKs are stubbed), and
mirrors the `src/` tree directory-for-directory so that the tests for a subsystem
live at the matching path. This page explains the tooling, the full `pnpm test`
pipeline, and — for each subsystem — the narrowest command that proves a change
while preserving complete failure output.

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
`**/benchmarks/*/repo/**`. A KEB benchmark under `evals/keb/benchmarks/` can
rebuild an upstream project's source tree into a `repo/` directory that carries
that project's own `*.test.ts` files. Those belong to the fixture under study,
not to OpenWiki, so the exclusion guarantees that a benchmark whose `repo/`
happens to be present on disk cannot pollute this project's suite.

## Evaluation subsystems (separate test suites)

The `test/` tree documented on the rest of this page validates the OpenWiki
application (`src/`). The two evaluation harnesses under `evals/` —
[`evals/ledger/`](../testing/evals.md) (LEDGER) and
[`evals/deepswe/`](../testing/evals.md) (DeepSWE) — are **not** part of that
suite. They are self-contained subsystems with their own entry points, type
config, and test runners, so changing an eval harness does not require the
application `pnpm test` gate and vice versa. See the
[Evaluation Systems](../testing/evals.md) page for the full architecture of
both harnesses; this section covers only how each is tested.

### LEDGER (`evals/ledger/`) — Vitest, with its own tsconfig

LEDGER's test suite is Vitest, but the harness lives outside `test/` and is
not driven by the root `vitest.config.ts` — that config only tunes discovery
and `src/` coverage, so the `evals/ledger/**/*.test.ts` files run as ordinary
Vitest tests that you invoke explicitly (the README documents
`pnpm exec vitest run evals/ledger`). The suite is offline and substitutes
deterministic evaluator and system implementations; live evaluator
calibration is opt-in through `LEDGER_LIVE=1`.

LEDGER ships its own TypeScript project: `evals/ledger/tsconfig.json` extends
the root `tsconfig.json`, sets `noEmit`/`declaration: false`, and widens
`include` to `**/*.ts` so it type-checks the eval source (which sits outside
the application `src/` root). Two npm scripts wrap the harness:

- `pnpm run eval:ledger` — runs `tsx evals/ledger/run.ts`, the live
  checkpoint-replay evaluation (replays a benchmark's Git history through
  OpenWiki and grades each frozen wiki snapshot).
- `pnpm run eval:ledger:typecheck` — runs `tsc --noEmit -p
  evals/ledger/tsconfig.json`, the focused typecheck for the LEDGER source.
  (A `eval:ledger:reevaluate` script re-judges a completed run without
  re-invoking OpenWiki.)

These are separate from the application `typecheck`/`test` scripts and must
be run explicitly when changing the LEDGER harness.

### DeepSWE (`evals/deepswe/`) — Python unittest

DeepSWE is a Python harness and has no TypeScript or Vitest footprint at all.
Its tests are Python `unittest` modules under `evals/deepswe/tests/`
(`test_run.py`, `test_analyze_openwiki_usage.py`) and must run inside the
pinned Harbor/LiteLLM environment the harness itself uses, via
`uvx --python 3.12 --from 'harbor[langsmith]==0.20.0' --with 'litellm==1.83.14'
python -m unittest discover -s evals/deepswe/tests -p 'test_*.py'`. The harness
itself is driven by `python3 evals/deepswe/run.py` (no npm script is defined
for it in `package.json`).

## Test layout maps to source subsystems

`test/` mirrors `src/`. To find (or add) tests for a subsystem, go to the
matching path. The most important mappings:

| Test directory                                                                                                                                            | Source subsystem it validates                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `test/agent/`                                                                                                                                             | `src/agent/` — model creation, middleware, prompts (planner/page-worker and system prompts), Vertex AI surface dispatch, streaming, redaction, the repository runner (including parallel page workers, skip/restore, and worker-response coercion), update-noop fast-skip, repository source fingerprinting, OKF middleware, frontmatter validation, and the wiki finalizer |
| `test/claims/`                                                                                                                                            | `src/claims/` — grounded-claim core, the code claim brain, and evidence resolution                            |
| `test/connectors/`                                                                                                                                        | `src/connectors/` — connector config, resilient fetch, MCP client/runtime, and per-source ingestion           |
| `test/generation/`                                                                                                                                        | `src/generation/` — repository run lifecycle, page planning, page-manifest persistence, and run-state persistence                                 |
| `test/okf/`                                                                                                                                              | `src/okf/` — OKF frontmatter parsing/normalization/repair/validation and index labels/sync |
| `test/integrations/`                                                                                                                                      | `src/integrations/` — host installers, config adapters, the MCP server, and packaged skill/protocol contracts |
| `test/cli/` (incl. `test/cli/run-log/`)                                                                                                                    | `src/cli/` — CLI wiring, Ink components, the run-log reducer/progress/summary/activity/tool-input helpers, and error diagnostics (`--debug` stack extraction/redaction, OpenRouter metadata, `previous_errors` capping)                                    |
| `test/setup/`                                                                                                                                             | `src/setup/` — the credentials setup wizard                                                                   |
| `test/visualize/`                                                                                                                                          | `src/visualize/` — the live-server/static-export HTML page, graph payload, server, static export, client-lib pure logic, and browser client interaction wiring |
| `test/config/`, `test/mermaid/`, `test/scheduling/`, `test/telemetry/`, `test/auth/`, `test/ingestion/`, `test/platform/` | the matching `src/` subsystem                                                                                 |

Related architecture and subsystem pages: the
[source map](../architecture/source-map.md),
[grounded claims](../concepts/grounded-claims.md),
[coding-agent integrations](../integrations/coding-agents.md), and the
[repository generation workflow](../workflows/repository-generation.md).

### Agent: the repository runner and its prompts

The repository runner (`runNativeRepositoryGeneration` in
`src/agent/repository-runner.ts`) drives the planner and the page workers, and
its test (`test/agent/repository-runner.test.ts`) is the broadest exercise of
that control flow. The test mocks `deepagents` and
`src/generation/repository-run.js` through a `vi.hoisted` harness that arms
planner and page-worker failure modes via named counters — `pageWorkerFailures`,
`pageWorkerPostSubmitFailures`, `workerExitsWithoutSubmit`,
`duplicatePlanSubmission`, `invalidPlanSubmissions`, `invalidPageSubmissions`,
`driftOnce`, `noop`, plus `pageGate`/`nextPageGate` gates and `fatalPageSubmissions`
to control concurrent scheduling.

The harness proves the **sequential, single-worker shape** first: the planner
and each page worker get an exact shell-free filesystem tool surface (planner
gets `read_file`/`ls`/`glob`/`grep`; page workers add `write_file`/`edit_file`,
never `execute` or `task`), one fresh `createDeepAgent` worker is built per
page, page-worker system prompts carry the `You own exactly <path>` ownership
line, and worker narration is streamed away (no `text` event reaches the
caller) while the approved `read_file`/`write_file`/`grep` tool lifecycle
events do. It also covers the **skip path** `restores and leaves a page pending
when its worker does not submit`: when `workerExitsWithoutSubmit` makes a page
worker exit without calling `submit_page`, the runner calls the mocked
`captureRepositoryPageSnapshot`/`skipRepositoryPage` (counted by
`restoreCalls`) to restore the snapshot, marks that page `skipped`, finishes
the run, and emits a `text` event telling the user the page will be
"reconsidered on the next update" — so the skipped page is re-queued as
`pending` on resume.

The runner can also document pages **concurrently**. `runPendingPageAgents`
builds a `PageWorkerPool` of up to `pageConcurrency` slots, and the test passes
`pageConcurrency` (with `workerStartStaggerMs: 0`) through `runHarness` to drive
it. The `runNativeRepositoryGeneration with concurrent page workers` suite pins
the concurrency contract:

- **Quickstart last.** With several workers, quickstart is held back from the
  first wave (none of the first workers owns `/openwiki/quickstart.md`) and is
  documented last in a single-worker pass once the rest of the queue is done, so
  its task-routing map links to pages that already exist. With one worker the
  queue order already places quickstart last.
- **Distinct pages at once.** With `pageConcurrency: 3`, the planner plus three
  page workers exist before any page is submitted (verified by gating workers
  through the harness `pageGate`), and `generating` progress events carry the
  completed count plus the in-flight page list once more than one worker is
  active. A single worker keeps the historical event shape (no
  `inFlightPages`/`completedCount`).
- **Rate-limit back-off.** A worker that fails with a 429 (`pageWorkerFailures`
  plus a `pageWorkerFailureError` carrying `status: 429`) is skipped and the
  pool size is lowered by one with a `Reduced page concurrency to <n>` text
  event; an ordinary (non-rate-limit) worker failure is skipped but does **not**
  lower concurrency.
- **Fatal submission isolation.** A fatal `submitRepositoryPage` error (armed
  via `fatalPageSubmissions`) lets in-flight workers submit or skip, records
  the fatal error on the pool, stops new jobs from starting, and is rethrown
  before `finish` — so `finishCalls` stays `0` and the run never finalizes with
  a pending page. A companion test gates the next acquisition to prove a worker
  that would acquire a page after a sibling fails fatally never starts it; the
  unclaimed page stays `pending`.

The suite also pins two sequential failure semantics. **Duplicate-plan
tolerance** (`continues when the planner repeats the same accepted plan`, armed
via `duplicatePlanSubmission`) repeats the accepted `submit_plan` call and
asserts the runner proceeds to page generation rather than treating the repeat
as a conflict (`planSubmissionCalls` is `2`, the duplicate tool result is the
accepted payload, and the page still completes). **Post-submit page durability**
(`keeps a durably completed page after a later worker failure`, armed via
`pageWorkerPostSubmitFailures`) makes the page worker throw after `submit_page`
succeeds and asserts the page is not rolled back — `restoreCalls` stays `0` and
the page remains `complete` — because `runPageAgent` guards its
`streamWorkerTools` catch with `if (submitted) return { status: "submitted" }`
so a post-submit worker throw returns a submitted outcome rather than calling
`skipRepositoryPage`.

Finally the suite covers `coerceRepositoryWorkerModelResponse`, the
normalization the repository-worker `NO_DELEGATION_MIDDLEWARE` applies before
LangChain validates each `wrapModelCall` response: OpenAI-compatible providers
can emit a first SSE delta without `role:"assistant"` (for example a
reasoning-only first delta), so the aggregated message arrives as a generic
`ChatMessage`/`ChatMessageChunk` instead of an `AIMessage`/`AIMessageChunk`
and LangChain would reject it. The `coerces roleless generic streaming
aggregates before LangChain validates wrapModelCall` test feeds a
role-undefined `ChatMessageChunk` carrying `additional_kwargs.reasoning_content`
and raw `tool_calls`, asserts the tool-filter still strips the `task`
capability from the downstream request, and asserts the result is an
`AIMessageChunk` preserving the text, `reasoning_content`, and parsed
`tool_calls` (collapsing the chunked tool-call into a `tool_call` with
`type:"tool_call"`). The `coerces generic assistant messages before LangChain
validates wrapModelCall` test feeds an explicit-role `assistant` `ChatMessage`
with raw `tool_calls` and asserts it becomes an `AIMessage` with parsed
`tool_calls`, while `leaves non-assistant generic model responses untouched`
asserts a `user`-role `ChatMessageChunk` is returned unchanged (not coerced)
so non-assistant output is never silently rewritten. The `filters DeepAgents'
automatic task capability at the model boundary` test pins the same
middleware's removal of the general-purpose `task` tool from the
model-facing request, so the non-delegating workers never advertise
delegation. `isRateLimitError` is unit-tested directly for status/`statusCode`/
`code`/message/`cause` recognition, and `parseWorkerToolEvent` is tested to
forward only approved worker tool lifecycle events (`read_file`, `write_file`,
`grep`, …) while dropping `execute`/`task` and `messages`-channel narration.

The remaining agent tests guard the prompts and adjacent surfaces:

- `test/agent/repository-prompts.test.ts` exercises the repository planner and
  page-worker prompt builders (`createRepositoryPlannerPrompt`/
  `createRepositoryPagePrompt` from `src/agent/repository-prompts.ts`) against
  fully-shaped `ActiveBeginView`/`RepositoryPageWorkerJob` fixtures. It pins
  that the planner prompt carries the actual user/connector context, the
  per-page committed update windows (with `Baseline <head>` or
  `Baseline unknown (full review required)`), the claim issues requiring
  reconciliation, the wiki goal, and the planning instructions (hierarchical
  paths, `relatedPages`, `submit_plan directly`), and that the page-worker
  prompt propagates only the Claims requiring explicit reconciliation, stamps
  the "You own exactly <path>" ownership line, and emits the sparse-Claim and
  canonical-evidence (`repo://...`) guidance.
- `test/agent/vertex-surface.test.ts` exercises the Vertex AI surface dispatch
  in `src/agent/vertex-surface.ts`. `resolveVertexSurface` routes Claude ids to
  the `anthropic` surface, partner/MaaS ids (meta, mistral, deepseek, qwen,
  codellama) to the `openai-maas` surface, and xAI Grok ids (`xai/grok-…`,
  bare `grok-…`, `publishers/xai/models/grok-…`) to the `openai-maas` surface —
  Grok is served over the OpenAI-compatible endpoint like every other partner
  model, and falling through to `gemini` would address it as a non-existent
  `publishers/google/models/grok-…` path. Gemini/Gemma ids and unknown
  publishers default to `gemini`, and the family-token boundary
  (`^|/`) prevents a token embedded mid-word (e.g. `gemini-metallica`) from
  being misclassified. The suite also pins `stripPublisherPath`/
  `toVertexPublisherModel`, the regional vs. global `vertexOpenAIBaseUrl`
  endpoint construction, `withAnthropicAuthEnvNeutralized` (hides
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` during construction and restores
  the prior value — or prior absence — even if construction throws), and
  `createVertexAuthFetch` (injects a fresh bearer token per request and throws
  before the request when no access token is available).
- `test/agent/update-noop.test.ts` is the dedicated suite for the update no-op
  fast-skip path: it builds a real committed Git repository with an OpenWiki
  tree and exercises `getUpdateNoopStatus` across the conditions that should and
  should not skip (unchanged HEAD, output-language change, equivalent
  primary-language request, committed-only dirty run metadata, page-manifest
  migration, uncommitted worktree changes, ignored-only paths, OpenWiki-only
  commits). It also guards the metadata-refresh path so a skip preserves the
  persisted language (mirroring `runOpenWikiAgent`'s `writeLastUpdateMetadata`
  refresh) and covers `shouldCheckUpdateNoop`'s gating conditions.
- `test/agent/repository-source-fingerprint.test.ts` exercises
  `createRepositorySourceFingerprint`/`createRepositorySourceSnapshot` and
  `getRepositoryChangedPaths` against a committed Git repository in `mkdtemp`.
  It pins fingerprint stability, sensitivity (tracked/staged/unstaged content,
  deletions, untracked files, executable-bit, symlink-target changes,
  `.openwikiignore` rules), the exclusion of generated pages/Claims
  sidecars/run metadata, and two failure-mode races injected by wrapping
  `node:fs/promises` with `vi.mock`: a TOCTOU race where an inspected file
  becomes a symlink before opening (the fingerprinter fails closed rather than
  following the swapped target), and a set of Windows stat-identity drift tests.
  On non-Windows the same-file guard keys on `dev`/`ino`; on Windows it falls
  back to `size`/`mtimeNs`/`birthtimeNs` and excludes `ctimeNs` (which can
  change for the same file between `lstat` and `FileHandle.stat`). The tests
  stub `process.platform` to `win32` and inject stat mutations via the mocked
  `open`: a `dev`/`ino` drift and a `ctimeNs`-only drift both still resolve, a
  `size`/`mtimeNs`/`birthtimeNs` change rejects with
  `Source path changed while fingerprinting`, and on other platforms a
  `dev`/`ino` change rejects.
- `test/agent/stream-redaction.test.ts` exercises `parseAgentStreamChunk`,
  pinning its suppression of `file`, `image`, `input_file`, and `image_url`
  content blocks that carry base64 blobs (which must never reach the terminal)
  while allowing adjacent text blocks in the same chunk to stream through
  normally. It also covers plain-text streaming, nested task (`subgraph`)
  output, `model_request` namespace classification (a top-level
  `model_request:*` namespace is tagged `main` while a `task` +
  `model_request:*` namespace is tagged `subgraph`), tool lifecycle
  normalization (`on_tool_start`/`on_tool_end`/`on_tool_error`), the
  `updates`-mode state-diff extraction (default for openai-compatible
  providers, tagged `main` or `subgraph` by namespace), tool-call-only
  messages in `updates` chunks returning `null` (a message carrying only
  `tool_calls` has no renderable text), and rejection of malformed stream
  chunks.

The agent subsystem directory also holds the OKF-authoring-pipeline tests:
`test/agent/frontmatter-validator.test.ts` exercises `validateOkfFrontmatter`
in isolation against accepted/rejected frontmatter families;
`test/agent/index-middleware.test.ts` drives `createOpenWikiIndexMiddleware`
against a real `OpenWikiLocalShellBackend` in an `mkdtemp` dir (including
broken-Mermaid failure paths); and `test/agent/wiki-finalizer.test.ts`
exercises `prepareWikiForAuthoring` and `finalizeWikiArtifacts` against an
isolated repository-mode backend.

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

The cross-cutting `test/connectors/mcp-client.test.ts` exercises the MCP client
surface. Its `buildChildEnv` suite drives the child-environment builder that
filters the parent process env so OpenWiki credentials never leak to spawned MCP
servers: it confirms secret keys are absent from the child env, allow-listed
base variables (`PATH`, `APPDATA`, `LOCALAPPDATA`) pass through, only the
credentials a transport explicitly declares are resolved, an unresolvable
declared reference throws, and invalid child env key names are rejected. It now
also pins the `mcp-empty-env-var` fix: a declared env var set to an empty string
(`MCP_EMPTY=""`) is treated as **present** and resolves to `""`, not as missing —
so empty-string env vars survive the child-env boundary rather than being
dropped. The rest of the file validates the untrusted connector config
**before** any subprocess spawns or network transport opens, exercising
`executeMcpTool`/`listMcpTools`/`executeMcpReadOnlyOperations` against
missing-transport, invalid-operation-name, and bad-command/URL pre-flight
rejections with no real child process or connection involved.

A small number of connector-related tests live at the `test/` root rather than
under `test/connectors/sources/` because they cross the single-source boundary
and exercise isolation contracts that only make sense across connectors or
streams:

- `test/git-repo-connector.test.ts` builds real throwaway git repos in temp
  dirs and drives the git-repo connector across two runs. It asserts the
  second-run manifest describes what was committed *since* the recorded head
  (issue #409) — naming the file added in the new commit, not the file from the
  already-ingested first commit, with the prior head carried as `previousHead`
  — and that a first run reports the working-tree diff only with no
  `previousHead`, and a second run against an unreachable recorded head (as
  after a force-push or garbage-collected rewrite) falls back to the
  working-tree diff rather than throwing.
- `test/ingest-all-connectors.test.ts` pins `openwiki_ingest_all_connectors`
  failure isolation (issue #412): it mocks the connector registry with two
  fake connectors — one that resolves and one that rejects — and asserts the
  tool still returns both outcomes, so a throwing connector does not discard a
  succeeding connector's result (the failure is surfaced as an `error` status
  with the message mirrored into `warnings`, while the success keeps its
  `rawFiles`).
- `test/x-connector-stream-isolation.test.ts` pins X-connector per-stream
  failure isolation (issue #412): it stubs `fetch` so one stream
  (`mentions`) returns 429 while another (`user_posts`) succeeds, and asserts
  the run does not abort — the succeeding dump is kept, the failing stream's
  failure is surfaced as a warning, both streams were still attempted, and state
  is still written. A complementary case where every stream fails asserts the
  run yields an `error` status (not a benign skip) with the per-stream warning.
- `test/openrouter-debug-fetch.test.ts` pins the OpenRouter debug-fetch
  concurrency contract (issue #411): `ChatOpenRouter` calls `globalThis.fetch`
  directly, so `installOpenRouterDebugFetch` patches the global. The test
  asserts that a single run restores the exact original `fetch` on detach, that
  overlapping runs each keep their own captured failure and the real `fetch` is
  restored exactly once — only after the last run detaches (reference-counted,
  with a redundant `restore()` being a no-op that does not prematurely restore
  while another run is still active) — that an OpenRouter failure fans out to
  every active run's sink while each run can clear its own failure, and that
  non-OpenRouter requests pass through untouched.

### OKF: frontmatter and index

`test/okf/` mirrors `src/okf/`. `test/okf/frontmatter.test.ts` is the broadest
OKF frontmatter suite: it covers `normalizeConceptContent` (regenerating
frontmatter for bare pages, repairing optional fields while preserving
producer-defined extensions, stamping a localized concept type), and the
`parseFrontmatterFields`/`renderFrontmatter`/`validateOkfFrontmatter`/
`repairOkfFrontmatter`/`validatePersistedFile` helpers. Sibling files
(`test/okf/index-labels.test.ts`, `test/okf/index-sync-errors.test.ts`,
`test/okf/claims-verification.test.ts`, `test/okf/claim-sources.test.ts`) cover
index labels, index-sync error paths, and claims verification/source projection.

### Generation: planning, manifests, run state, and the run lifecycle

`test/generation/` splits the repository-generation machinery by persistence
concern, mirroring `src/generation/`:

- `test/generation/page-manifest.test.ts` covers the page-manifest persistence
  and completion surface (`readRepositoryPageManifest`,
  `writeRepositoryPageManifest`, `replaceRepositoryPageManifest`,
  `recordRepositoryPageCompletion`, `seedRepositoryPageManifest`,
  `isRepositoryPageCompletionCurrent`, atomic-rename replacement). It injects a
  manifest-rename failure by wrapping `node:fs/promises` with `vi.mock` and
  asserts the manifest is not left in a half-written state, and refuses to
  advance an unverified or mismatched Claims page while recording the exact
  verified page bytes and source checkpoint on success.
- `test/generation/run-state.test.ts` covers `writeRepositoryRunState`/
  `readRepositoryRunState`/`removeRepositoryRunState` against a temp root: the
  atomic write/read, validation rejection (a wrong `schemaVersion` must not
  replace durable state), and temp-file cleanup when rename fails.
- `test/generation/page-jobs.test.ts` exercises `createRepositoryPlan` and
  `reconcilePageClaims` through a `ClaimSession` with a deterministic evidence
  resolver. The `createRepositoryPlan` suite pins plan construction: init
  requires `/openwiki/quickstart.md` and forbids init deletions, quickstart
  deletion is forbidden, duplicate planned pages and generate/delete overlap
  are rejected, structural and reserved working pages (`index.md`,
  `nested/_draft.md`) are rejected, and page inputs are normalized with
  quickstart ordered last. The `reconcilePageClaims` suite pins sparse
  reconciliation: omitted issue-free Claims are retained without model
  round-tripping, a stale or unresolved Claim requires an explicit
  confirm/update/retract decision, duplicate sparse proposals and conflicting
  double-decisions (the same id in both `confirmedClaimIds` and
  `retractedClaimIds`) are rejected, retracting every Claim on a factual page
  is forbidden, an already-absent retraction is an idempotent retry, Claim
  fingerprints containing delimiter characters are not conflated, and session
  state stays atomic when evidence resolution fails.
- `test/generation/repository-run.test.ts` is the end-to-end run-lifecycle test
  described in detail below.

### Ingestion: code-mode setup and connectors

`test/ingestion/` mirrors `src/ingestion/`. `test/ingestion/code-mode.test.ts`
exercises `ensureCodeModeRepoSetup` and `runCodeModeConnectors` against temp
repositories: it parses the generated GitHub Actions workflow YAML, pins the
agent files and workflow/provider blocks (including ordered steps, the
failure-propagation `propagate` step, and the PR annotation), and asserts the
OpenWiki `<!-- OPENWIKI:START -->`/`<!-- OPENWIKI:END -->` managed-snippet
contract around legacy sections and hand-written content. It also pins
`CLAUDE.md` handling in `ensureCodeModeRepoSetup`: when both agent files are
absent it creates `CLAUDE.md` as a simple `@AGENTS.md` reference rather than a
copy of `AGENTS.md`'s content (it contains `@AGENTS.md`, not an inert Markdown
link, and is shorter than `AGENTS.md`); when `CLAUDE.md` is a symlink to
`AGENTS.md` it inlines the instructions instead of emitting an `@AGENTS.md`
import (which would point the file at itself); and a pre-existing `CLAUDE.md`
that only imports `AGENTS.md` (e.g. `@AGENTS.md`) is preserved unchanged rather
than overwritten — so an import-only `CLAUDE.md` survives a re-setup. Sibling files
(`test/ingestion/ingestion-run.test.ts`, `test/ingestion/ingestion.test.ts`,
`test/ingestion/langsmith-modes.test.ts`) cover the ingestion run,
`parseIngestionTarget`/`createConnectorSynthesisGuidance`, and connector modes.

### CLI: run-log, diagnostics, and Ink components

`test/cli/` mirrors `src/cli/`, splitting CLI wiring (TypeScript entry points)
from Ink components and the run-log rendering helpers. The Ink components live
under `test/cli/components/` and the credentials setup wizard's component tests
live under `test/setup/credentials/` (see the tooling section above for the
`ink-testing-library` pattern).

The **run-log** helpers reduce the `OpenWikiRunEvent` stream into the items the
Ink App renders, and `test/cli/run-log/` tests each one in isolation:

- `test/cli/run-log/reducer.test.ts` exercises `appendRunLogEvent`: text
  handling (appending, dropping empty/subgraph narration, concatenating
  consecutive assistant text), repository-progress state replacement (a new
  `generating` stage replaces the prior lifecycle stage without losing the
  active tool line, and it retains the concurrent-worker `completedCount`/
  `inFlightPages` fields), planning/replanning/finalizing/no-op stage retention,
  and tool grouping (a `tool_start` starts a running line, concurrent tool calls
  merge into one group that stays running until every call has ended, `tool_end`
  settles to `done` or `error`, and an unknown end id leaves the log
  unchanged). It pins the path-activity tracking: successful repository reads
  and OpenWiki writes are recorded as unique explored/written paths, failed
  writes are not counted, `task` calls are counted in the aggregate summary, and
  completed path history is bounded (the last eight activities are kept); an
  `execute` shell command is never guessed as a filesystem path.
- `test/cli/run-log/progress.test.ts` exercises `formatRepositoryProgress`/
  `formatRepositoryPrintProgress`: the single-worker "Documenting page N of M"
  line, the degenerate case where a concurrent run collapses back to that line
  when only one page remains in flight, and the multi-worker "Documenting N of
  M · K in flight: …" line that lists the in-flight pages.
- `test/cli/run-log/summary.test.ts` exercises `formatRunCompletionTitle` (a
  minute-scale init title from unique written pages, and an "up to date" update
  with no writes) and `formatCompletedRunCounts` (which omits raw write calls
  after completion).
- `test/cli/run-log/activity.test.ts` exercises the file-path activity helpers:
  `getToolPathActivities` normalizes virtual file paths and classifies them
  (a `write_file` into `/openwiki/...` is a `write` scoped to `openwiki`; a
  `glob` uses the non-wildcard ancestor as a search scope; tools without
  trustworthy filesystem provenance like `execute` yield nothing),
  `isOpenWikiPagePath` admits only persistent Markdown pages (not
  `.last-update.json` or `.claims/...`), and `buildActivityTreeLines`/
  `buildExplorationTreeLines` render shared directory ancestry across active
  files and highlight the active read.
- `test/cli/run-log/tool-input.test.ts` exercises `parseToolInput` (JSON parsing
  with passthrough of other values) and `countToolTargets` (direct, keyed, and
  stringified array counting, defaulting to one).

The non-run-log CLI test worth knowing about:

- `test/cli/diagnostics/error-diagnostics.test.ts` exercises
  `getErrorDiagnostics`, the helper behind the `--debug` diagnostic surface. It
  asserts that a plain `Error` returns nothing when debug is off, while debug
  mode extracts the error `name`, `message`, and an inline HTTP status parsed
  from the message (`httpStatusFromMessage`). The stack is only included when
  `OPENWIKI_DEBUG` is set; when present it is sanitized — secret-like patterns
  in the stack (e.g. a `bearer sk-or-v1-…` token) are replaced with a
  `[REDACTED:OPENROUTER_API_KEY]` placeholder — and truncated to exactly 2000
  characters with a trailing `...`. It also covers HTTP status and
  case-insensitive header extraction from response-like errors, OpenRouter
  metadata extraction (`metadata.provider_name`) which happens even with
  debug off, redaction of secret-like keys inside stringified metadata
  (`metadata.raw`), previous-errors capping (only the first five
  `previous_errors` are kept, with a `metadata.previous_errors.more` note
  counting the remainder), and nested response fields surfaced under a dotted
  prefix (`response.status`/`response.statusText`).

### Config: env parsing, formatting, and provider constants

`test/config/env.test.ts` exercises `parseEnv` and `formatEnv` from
`src/config/env.ts`, the `.env`-style loader and serializer behind the managed
environment keys. `parseEnv` parses simple `KEY=value` lines, skips blanks and
comments, ignores lines with no `=` or an empty key, rejects keys that are not
`UPPER_SNAKE_CASE`, handles `export`-prefixed lines, and leaves unquoted values
as-is. For double-quoted values it now includes tests for the **atomic
single-pass unescaping** of backslash escapes: it unquotes and unescapes
`"line1\nline2"`, `"a\"b\\c"`, and — newly — carriage returns (`"line1\rline2"`
and `"line1\r\nline2"`), as well as the **Windows-path corruption regression**
where a raw backslash escaped to `\\` immediately before a path segment
starting with `n` or `r` (e.g. `C:\name\creds.json`) must not be misread as the
`\n`/`\r` escape sequence on parse. The `formatEnv` suite mirrors this:
quoting, escaping quotes/backslashes/newlines, escaping carriage returns, and
ordering managed keys first (in `MANAGED_ENV_KEYS` order) then unknown keys
sorted alphabetically. A `parseEnv <-> formatEnv` round-trip suite confirms
values — including carriage returns and the Windows path regression — survive
a `format → parse` round-trip. The `MANAGED_ENV_KEYS` suite pins which keys the
managed-environment surface owns: the output-token limits
(`OPENWIKI_MAX_OUTPUT_TOKENS`, `OPENWIKI_BEDROCK_MAX_TOKENS`), the stream idle
timeout (`OPENWIKI_STREAM_IDLE_TIMEOUT`), the **repository page-worker
concurrency** (`OPENWIKI_PAGE_CONCURRENCY`), the gemini-enterprise (Vertex)
Google Cloud settings (`GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION`/
`GOOGLE_APPLICATION_CREDENTIALS`), the AI-Studio `GEMINI_API_KEY`, the hosted
OpenAI-compatible provider base URLs (`BASETEN_BASE_URL`, `BOB_BASE_URL`,
`FIREWORKS_BASE_URL`, `NVIDIA_BASE_URL`), and the reasoning-effort settings
(`OPENWIKI_REASONING_EFFORT`,
`OPENWIKI_OPENAI_COMPATIBLE_REASONING_EFFORT_SUPPORTED`).

`test/config/constants.test.ts` is the broad provider-constants suite for
`src/config/constants.ts`. It pins model-id validation, provider normalization
and resolution, the `resolveProviderBaseUrl` defaults and overrides — including
the hosted OpenAI-compatible providers where `BOB_BASE_URL` (via
`BOB_BASE_URL_ENV_KEY`) and the baseten/fireworks/nvidia keys override the
built-in defaults while a whitespace-only override falls back to the default
(`bob` is among the providers with a built-in default) — provider retry
attempts, per-provider max-output-token ceilings, stream-idle-timeout
resolution, reasoning capability flags, the Bedrock AWS-SDK credential/region
surface, and provider API-key env-key resolution. It also pins the page-worker
concurrency resolver `resolvePageConcurrency`: it defaults to one sequential
worker (`DEFAULT_PAGE_CONCURRENCY === 1`), accepts trimmed integers up to
`MAX_PAGE_CONCURRENCY`, and rejects out-of-range or non-integer values, and
`resolveProviderRetryAttempts` raises its default for concurrent page workers
(`pageConcurrency > 1` uses `PARALLEL_PROVIDER_RETRY_ATTEMPTS`) unless an
explicit `OPENWIKI_PROVIDER_RETRY_ATTEMPTS` override is set. Base-URL
validation (`isValidBaseUrl`/`isValidProviderBaseUrl`) accepts API root URLs
for openai-compatible providers and rejects `/chat/completions` endpoints,
keeping generic `http(s)` validation for other providers. Sibling files
(`test/config/env-behavior.test.ts`, `test/config/copilot-provider.test.ts`,
`test/config/openai-chatgpt-provider.test.ts`, `test/config/openwiki-home.test.ts`)
cover `loadOpenWikiEnv`/`saveOpenWikiEnv`, credential preview/diagnostics (with
the bob base URL surfaced in diagnostics), the GitHub Copilot and OpenAI-ChatGPT
provider configs, and the OpenWiki home/connector path helpers.

### Visualize: page, graph, and client interaction

`test/visualize/` mirrors `src/visualize/`. It splits the visualizer into the
parts that can run in plain Node and the browser-only client glue that cannot:

- `test/visualize/page.test.ts` asserts on the rendered `PAGE`/`STATIC_PAGE`
  HTML documents exported by `src/visualize/page.ts`. It pins the exact CDN
  script versions (force-graph, marked, dompurify, mermaid) and requires each
  `<script>` tag to carry an SRI `integrity` plus `crossorigin="anonymous"`
  attribute, so a version bump is forced through this test with a fresh hash
  review rather than silently trusting the CDN. It also guards the issue #670
  overlay-layout regression: the hint and legend must live inside the `#graph`
  panel (not direct children of `.main`) and the stylesheet must height-cap
  `.graph-overlay` with a scrollable `.legend`. A CSP Google Fonts regression
  test asserts that the page's Content Security Policy allows the very origins
  the page itself requests: `style-src` must include `fonts.googleapis.com`
  (the stylesheet the `<link>` tag loads) and `font-src` must include
  `https://fonts.gstatic.com` (the font files that stylesheet references), so a
  browser enforcing the CSP no longer silently blocks the Inter typeface.
- `test/visualize/client-interaction.test.ts` is a `@vitest-environment jsdom`
  suite for the browser-only `src/visualize/client.ts` interaction wiring.
  Because `client.ts` touches the DOM and CDN globals at import time, the test
  mounts a minimal DOM matching `page.ts`'s post-#670 layout, replaces the
  third-party globals (`ForceGraph`, `marked`, `DOMPurify`, `mermaid`,
  `ResizeObserver`, `fetch`) with recording stubs, imports the client under
  `data-static-export`, and asserts on the handlers it registers. Its primary
  target is the issue #670 regression: background clicks must not be wired to
  any handler, so clicking blank graph space never clears the reader, while
  node clicks select a page and highlight its sidebar entry. It also asserts
  the graph-label decluttering feature driven by `shouldShowNodeLabel`: by
  default no labels are painted, hovering a node draws only that node's label,
  and clicking a node draws its label plus the labels of its directly
  connected neighbours. These assertions call the registered
  `onNodeHover`/`onNodeClick` handlers and then paint every node through the
  recorded `nodeCanvasObject` handler, collecting the `fillText` calls to
  verify exactly which labels appear.

### Integrations: protocol, session manager, and MCP server

`test/integrations/` mirrors `src/integrations/`. It splits the host-integration
surface by transport boundary: the transport-neutral protocol schema, the
single-run session manager that adapts it, and the MCP transport server that
exposes it:

- `test/integrations/protocol.test.ts` exercises the strict Zod schemas in
  `src/integrations/core/protocol.ts`. It validates the complete protocol
  surface: `BeginInput` (strict, trims `root`/`language`, rejects unknown
  modes and extra fields), `RunInput`/`NextPageInput` (shared strict UUID run
  identity, with `RunInput === NextPageInput`), `SubmitPlanInput` (strict,
  accepts an empty `pages` array, rejects extra fields),
  `PlanPageInput` (canonicalizes `path`/`title`/`purpose`/`seedPaths`/
  `relatedPages`/`instructions`), and `SubmitPageInput` — the sparse Claim
  reconciliation schema with `confirmedClaimIds`/`claims`/`retractedClaimIds`.
  It asserts that a proposed Claim with empty evidence is rejected and that a
  proposed Claim carrying a code-owned `version` is rejected (only bare
  `resource` is accepted). `ProposedPageClaimInput` trims and canonicalizes
  the `id`/`statement`/`resource` fields. It also pins `isValidHostId`'s bounded
  canonical identity rules (`[a-z0-9-]{1,64}`, rejecting uppercase, underscore,
  and over-length identities).
- `test/integrations/session-manager.test.ts` exercises
  `HostSessionManager.create` and its single-run adapter over the real
  repository lifecycle. It asserts the ordered six-tool lifecycle
  (`openwiki_begin` → `openwiki_submit_plan` → `openwiki_next_page` →
  `openwiki_inspect_page_claims` → `openwiki_submit_page` → `openwiki_finish`)
  and that `inspectPageClaims` is exposed on demand. It covers resumability
  across different hosts (a `codex`-started run is resumed by `claude-code`),
  nested-path-to-Git-root resolution via `realpath`, the strict active-run-id
  guard, begin conflict mapping (a second `begin` with a conflicting mode
  rejects with `conflict` and retains the prior active run), the
  one-operation-at-a-time guard, repository lifecycle failure mapping to
  bounded `HostIntegrationError`s, the retention of active state when
  `finish` fails, the durable-finish completion that clears active state, and
  an older process-local run being cleared after a proven update no-op.
- `test/integrations/mcp-server.test.ts` exercises
  `createOpenWikiMcpServer` through linked in-memory MCP transports. It asserts
  the server advertises the six lifecycle tools in order and that the
  `INSTRUCTIONS` embedding (from `src/integrations/mcp/server.ts`) contains
  the sparse-workflow guidance — the host's native repository tools,
  `openwiki_submit_plan`/`openwiki_next_page`/`openwiki_inspect_page_claims`/
  `openwiki_submit_page`, that issue-free Claims are "retained
  automatically" and only sparse Claim decisions are submitted, the stale or
  unresolved recheck requirement, "Never report success before finish", and
  "source drift invalidated the plan" — while never mentioning the removed
  `openwiki_resolve_claims`. It also covers successful tool calls (text JSON
  plus structured content) and error bounding: a `HostIntegrationError` is
  surfaced as a bounded `isError` result while an unknown failure is replaced
  with a generic `OpenWiki MCP operation failed.` message and never leaks the
  sensitive text to the client or stderr. A lifecycle smoke test completes one
  factual init page through all five transport calls.

## Testing patterns you will reuse

- **Dependency injection via `vi.mock` + `vi.hoisted`.** Failure-path tests
  wrap a real module with `vi.mock(..., importOriginal)` and use a hoisted
  counter to inject a failure on the Nth call while otherwise delegating to the
  real implementation. `test/generation/repository-run.test.ts` arms a
  `failureHarness` with six counters — `manifestReplacements`,
  `manifestWrites`, `metadataWrites`, `stateWrites`, `stateRemovals`, and
  `sourceMutationsAfterManifestReplacement` — that wrap `page-manifest.js`
  (`recordRepositoryPageCompletion` for `manifestWrites`,
  `replaceRepositoryPageManifest` for `manifestReplacements` plus a
  mid-replacement source mutation for `sourceMutationsAfterManifestReplacement`),
  `agent/utils.js` (`writeLastUpdateMetadata` for `metadataWrites`), and
  `run-state.js` (`writeRepositoryRunState`/`removeRepositoryRunState` for
  `stateWrites`/`stateRemovals`) to inject manifest-, metadata-, and run-state
  write/removal failures and prove the runner's recovery and rollback behavior.
  These tests import the source modules directly (e.g.
  `../../src/okf/frontmatter.ts`, `../../src/generation/repository-run.ts`) so
  the run lifecycle is exercised through Vitest's transform without first
  building `dist/`.
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

### The repository-run lifecycle test

`test/generation/repository-run.test.ts` is the end-to-end integration test for
the repository generation workflow. It imports `parseFrontmatterFields` and
`validateOkfFrontmatter` from `src/okf/frontmatter.ts`, plus the run lifecycle
(`beginRepositoryRun`, `submitRepositoryPlan`, `nextRepositoryPage`,
`submitRepositoryPage`, `finishRepositoryRun`) and the skip/inspect primitives
(`captureRepositoryPageSnapshot`, `skipRepositoryPage`,
`inspectRepositoryPageClaims`) from `src/generation/repository-run.ts`, and
drives the full begin → submit_plan → next_page → submit_page → finish
lifecycle against a temporary committed Git repository. A `failureHarness`
created with `vi.hoisted` wraps the real `page-manifest.js`, `agent/utils.js`,
and `run-state.js` modules to inject failures on selected calls while otherwise
delegating to the real implementation (see the testing patterns above). Each
test creates a committed Git repository (via the `git`/`createRepository`
helpers), optionally arms the failure counters in `beforeEach`, and removes the
temporary directories in `afterEach`, so the run's recovery and rollback paths
are exercised against a real repository without leaving state behind.

The suite covers the full **page-queue lifecycle**: `nextRepositoryPage`
returns the first pending job (with its existing Claim count and
Claims-requiring-attention), `submitRepositoryPage` does not complete a page
until Claims and checkpoint state are durable (a Claims-persistence or
run-state-write failure leaves the page pending), `inspectRepositoryPageClaims`
returns the current pending page's complete Claims only for that page's job id
and throws for any other id, and `finishRepositoryRun` finalizes completed
work, stamps provenance, and persists run metadata.

The suite also covers the **skip path** for a page whose worker does not
submit: `captureRepositoryPageSnapshot` snapshots the on-disk Markdown and
Claims before the page is mutated, `skipRepositoryPage` restores that snapshot
and marks the page `skipped` (the `restores the exact pending Markdown and
Claims snapshot` test), and `finishRepositoryRun` accepts a
`skippedPageSnapshots` list so a finish-after-skip leaves the original content
and Claims in place, drops run state, and stamps an `interrupted` last-update
status. A separate `resets an interrupted skipped job to pending on resume`
test proves that resuming a run whose page was skipped re-queues that page as
`pending` rather than carrying the skipped status forward. A
`treats an absent page as a restorable snapshot` parameterized test (init and
update) proves a never-written page snapshots `markdown: null`/`claims: null`
and rolling it back removes the file, and a
`tolerates a human-readable not-found error from the backend when skipping a
never-written page` test (regression for #765) asserts the skip path tolerates
a DeepAgents backend that returns `Error: File '...' not found` rather than a
`file_not_found` code, so rolling back a new page worker does not abort the
whole run.

## Choosing the narrowest validation per subsystem

Run the smallest slice that would fail if your change is wrong, then run the full
`pnpm test` gate before finishing. Use `pnpm exec vitest run <path>` to scope by
file or directory, or `-t "<name>"` to scope by test name.

- **A single subsystem:** `pnpm exec vitest run test/generation/` (swap in the
  matching directory from the table above).
- **A single file:** `pnpm exec vitest run test/agent/repository-runner.test.ts`.
- **A single connector source:** `pnpm exec vitest run test/connectors/sources/slack.test.ts`.
- **MCP client child-env (incl. empty-string var):** `pnpm exec vitest run test/connectors/mcp-client.test.ts -t "buildChildEnv"`.
- **Git-repo connector incremental diff:** `pnpm exec vitest run test/git-repo-connector.test.ts`.
- **Connector failure isolation (ingest-all):** `pnpm exec vitest run test/ingest-all-connectors.test.ts`.
- **X connector stream isolation:** `pnpm exec vitest run test/x-connector-stream-isolation.test.ts`.
- **OpenRouter debug-fetch concurrency:** `pnpm exec vitest run test/openrouter-debug-fetch.test.ts`.
- **A single named test:** `pnpm exec vitest run test/config -t "treats whitespace-only overrides as unset"`.
- **Ink components:** `pnpm exec vitest run test/cli/components/`.
- **Run-log helpers:** `pnpm exec vitest run test/cli/run-log/` (reducer/progress/summary/activity/tool-input), or `-t "retains concurrent worker progress fields"` for the concurrent-worker progress field pin.
- **Generation skip/restore path:** `pnpm exec vitest run test/generation/repository-run.test.ts -t "restores the exact pending Markdown and Claims snapshot"` (snapshot restore + `finishRepositoryRun` with `skippedPageSnapshots`) or `-t "resets an interrupted skipped job to pending on resume"` (resume re-queueing).
- **Agent sequential worker shape + skip path:** `pnpm exec vitest run test/agent/repository-runner.test.ts -t "restores and leaves a page pending when its worker does not submit"`.
- **Concurrent page workers:** `pnpm exec vitest run test/agent/repository-runner.test.ts -t "runs distinct pages at once and writes quickstart last"` (concurrency, held-back quickstart, in-flight progress), `-t "lowers concurrency after a rate-limited worker and continues"` (429 back-off), or `-t "lets in-flight workers settle before rethrowing a fatal submission"` (fatal isolation).
- **Duplicate-plan tolerance:** `pnpm exec vitest run test/agent/repository-runner.test.ts -t "continues when the planner repeats the same accepted plan"`.
- **Post-submit page durability:** `pnpm exec vitest run test/agent/repository-runner.test.ts -t "keeps a durably completed page after a later worker failure"`.
- **Repository-worker response coercion:** `pnpm exec vitest run test/agent/repository-runner.test.ts -t "coerces roleless generic streaming aggregates before LangChain validates wrapModelCall"` (roleless `ChatMessageChunk` → `AIMessageChunk` with collapsed tool calls), `-t "coerces generic assistant messages before LangChain validates wrapModelCall"` (`ChatMessage` → `AIMessage`), or `-t "leaves non-assistant generic model responses untouched"`.
- **Rate-limit / worker-tool-event helpers:** `pnpm exec vitest run test/agent/repository-runner.test.ts -t "recognizes status fields, codes, messages, and causes"` or `-t "forwards only approved tool lifecycle events"`.
- **Repository worker prompts (planner/page-worker):** `pnpm exec vitest run test/agent/repository-prompts.test.ts`.
- **Vertex AI surface dispatch (incl. Grok routing):** `pnpm exec vitest run test/agent/vertex-surface.test.ts` (Claude→anthropic, partner/Grok→openai-maas, Gemini/unknown→gemini, auth-fetch and env neutralization).
- **Update no-op fast-skip:** `pnpm exec vitest run test/agent/update-noop.test.ts`.
- **Source fingerprinting / changed paths:** `pnpm exec vitest run test/agent/repository-source-fingerprint.test.ts`.
- **Page manifest persistence:** `pnpm exec vitest run test/generation/page-manifest.test.ts`.
- **Run-state persistence:** `pnpm exec vitest run test/generation/run-state.test.ts`.
- **Plan construction and Claim reconciliation:** `pnpm exec vitest run test/generation/page-jobs.test.ts`.
- **Host protocol schema:** `pnpm exec vitest run test/integrations/protocol.test.ts`.
- **Host session manager:** `pnpm exec vitest run test/integrations/session-manager.test.ts`.
- **MCP server adapter and INSTRUCTIONS:** `pnpm exec vitest run test/integrations/mcp-server.test.ts`.
- **Code-mode ingestion setup:** `pnpm exec vitest run test/ingestion/code-mode.test.ts`.
- **Visualizer client interaction regression:** `pnpm exec vitest run test/visualize/client-interaction.test.ts` (jsdom; run `test/visualize/` for the full page/graph/client-lib slice).
- **Agent stream redaction:** `pnpm exec vitest run test/agent/stream-redaction.test.ts` (pins `parseAgentStreamChunk`'s suppression of file/image/input_file/image_url base64 blocks, `model_request` namespace classification, and `updates`-mode tool-call-only message handling).
- **CLI error diagnostics (`--debug`):** `pnpm exec vitest run test/cli/diagnostics/error-diagnostics.test.ts` (stack extraction/redaction/truncation, HTTP status, OpenRouter metadata, `previous_errors` cap).
- **Env parsing/formatting:** `pnpm exec vitest run test/config/env.test.ts` (double-quoted unescaping, carriage returns, Windows-path regression, `MANAGED_ENV_KEYS` membership including `OPENWIKI_PAGE_CONCURRENCY`, `BOB_BASE_URL`, and the hosted OpenAI-compatible base URLs).
- **Provider constants (incl. page-concurrency and Bob base-URL override):** `pnpm exec vitest run test/config/constants.test.ts` (model-id validation, provider resolution, `resolvePageConcurrency`, `resolveProviderBaseUrl` defaults/overrides for bob/baseten/fireworks/nvidia, retry/max-token/stream-timeout/reasoning surfaces).
- **LEDGER eval harness:** `pnpm exec vitest run evals/ledger` (the offline Vitest suite for the LEDGER source; run `pnpm run eval:ledger:typecheck` for its isolated tsconfig typecheck). These sit outside the application `test/` tree and `pnpm test` gate — see [Evaluation Systems](../testing/evals.md).
- **DeepSWE eval harness:** `python -m unittest discover -s evals/deepswe/tests -p 'test_*.py'` inside the pinned Harbor environment (no npm/Vitest entry point; see [Evaluation Systems](../testing/evals.md)).

Because tests import `src/` directly, a focused Vitest run does not require a
prior `pnpm build`. Reserve the full `pnpm test` (typecheck + build + coverage)
for confirming the change end-to-end.

### Preserve complete failure output

When a scoped run fails, capture the **entire** Vitest failure block — the failed
test name, the full assertion diff (expected vs. received), and the complete stack
trace — not a summarized line. The diff and stack are what let a reviewer or
follow-up run locate the regression. Do not truncate an assertion diff or drop
stack frames when reporting a failure.

## End-to-end and gated tests

Most of the suite is offline unit and integration tests. A small number of files
are named `*.e2e.test.ts` (for example
`test/agent/gemini-enterprise-claude.e2e.test.ts`) and exercise a real vendor SDK
path rather than a mock — that test drives the real Anthropic Vertex SDK plus the
real Mermaid DOM shim to guard the browser-guard workaround, using a throwaway
offline credentials file so no real token or network request is involved. These
still run in the default suite; they are named to signal that they cross an
integration boundary rather than testing a unit in isolation.
