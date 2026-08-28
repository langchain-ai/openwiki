---
type: testing-guide
title: Testing Guide
description: How the OpenWiki test suite is laid out, the vitest and ink-testing-library tooling it uses, the pnpm test pipeline, and how to scope the narrowest validation that proves a change per subsystem.
tags: [testing, vitest, coverage, ink-testing-library, ci, developer-workflow]
sources:
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
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
  - id: openwiki-source-f1b33b05f136bc4ed936d51d
    resource: repo://test/agent/update-noop.test.ts
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
  - id: openwiki-source-224b03172757408e1b558fa7
    resource: repo://test/ingestion/code-mode.test.ts
  - id: openwiki-source-d1d0d34cd042b7cd70476a68
    resource: repo://test/integrations/session-manager.test.ts
  - id: openwiki-source-5c504746431185b33e3c7f39
    resource: repo://test/mermaid/dom-shim.test.ts
  - id: openwiki-source-e944f18bb8361b7afa410349
    resource: repo://test/okf/claim-sources.test.ts
  - id: openwiki-source-5921cbc5549dfc1ee5c046a5
    resource: repo://test/okf/claims-verification.test.ts
  - id: openwiki-source-43240ab040106a6f63192176
    resource: repo://test/okf/frontmatter.test.ts
  - id: openwiki-source-2b788920f8a5c721b3430f6c
    resource: repo://test/openwiki-home.test.ts
  - id: openwiki-source-e3be493bc871948f42420690
    resource: repo://test/visualize/client-interaction.test.ts
  - id: openwiki-source-1904eaebd82125a3a3881dac
    resource: repo://test/visualize/page.test.ts
  - id: openwiki-source-fbadcd8591b65031efaaedce
    resource: repo://vitest.config.ts
generated: { by: "openwiki/0.4.3", at: "2026-08-27T23:20:02.895Z" }
verified:
  - by: openwiki/0.4.3
    at: 2026-08-27T23:20:02.895Z
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
that project's own `*.test.ts` files. Those belong to the fixture under test, not
to OpenWiki, so the exclusion guarantees that a benchmark whose `repo/` happens
to be present on disk cannot pollute this project's suite.

## Test layout maps to source subsystems

`test/` mirrors `src/`. To find (or add) tests for a subsystem, go to the
matching path. The most important mappings:

| Test directory                                                                                                                                            | Source subsystem it validates                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `test/agent/`                                                                                                                                             | `src/agent/` — model creation, middleware, prompts, streaming, redaction, the repository runner, OKF middleware, frontmatter validation, the wiki finalizer, repository worker prompts, the source fingerprint, and the update no-op preflight |
| `test/claims/`                                                                                                                                            | `src/claims/` — grounded-claim core, the code claim brain, and evidence resolution                            |
| `test/connectors/`                                                                                                                                        | `src/connectors/` — connector config, resilient fetch, MCP client/runtime, and per-source ingestion           |
| `test/generation/`                                                                                                                                        | `src/generation/` — repository planning, page jobs (including claim-issue reconciliation jobs), the page manifest (per-page source checkpoint and completion durability), run-state persistence, and the end-to-end repository-run lifecycle with durability, resumability, skip/restore, and failure-rollback paths |
| `test/okf/`                                                                                                                                              | `src/okf/` — OKF frontmatter parsing/normalization/repair/validation and index labels/sync, plus claims verification and claim-source projection |
| `test/integrations/`                                                                                                                                      | `src/integrations/` — host installers, config adapters, the MCP server, the host session manager lifecycle, and packaged skill/protocol contracts |
| `test/ingestion/`                                                                                                                                         | `src/ingestion/` — code-mode repo setup (agent files and CI workflow generation) and connector runs |
| `test/cli/`                                                                                                                                               | `src/cli/` — CLI wiring and Ink components                                                                    |
| `test/setup/`                                                                                                                                             | `src/setup/` — the credentials setup wizard                                                                   |
| `test/visualize/`                                                                                                                                          | `src/visualize/` — the live-server/static-export HTML page, graph payload, server, static export, client-lib pure logic, and browser client interaction wiring |
| `test/config/`, `test/mermaid/`, `test/scheduling/`, `test/telemetry/`, `test/auth/`, `test/platform/` | the matching `src/` subsystem                                                                                 |

Related architecture and subsystem pages: the
[source map](../architecture/source-map.md),
[grounded claims](../concepts/grounded-claims.md),
[coding-agent integrations](../integrations/coding-agents.md), the
[repository generation workflow](../workflows/repository-generation.md), and
[CI scheduling](../operations/ci-scheduling.md).

### Agent: middleware, frontmatter, finalizer, prompts, fingerprint, and no-op

The agent subsystem directory holds a broad set of tests, including several that
guard the OKF authoring pipeline added in the v0.4.0 cycle:

- `test/agent/frontmatter-validator.test.ts` exercises `validateOkfFrontmatter`
  in isolation, asserting which OKF frontmatter families are accepted (required
  `type`, optional `title`/`description`/`resource`/`tags`, the legacy v0.1
  `timestamp`/producer extensions, and the v0.2 provenance/trust/lifecycle
  families) and which malformed inputs are rejected (timestamps without an
  explicit UTC offset, impossible ISO-shaped timestamps).
- `test/agent/index-middleware.test.ts` drives `createOpenWikiIndexMiddleware`
  against a real `OpenWikiLocalShellBackend` rooted in an `mkdtemp` directory. It
  runs the middleware's `beforeAgent`/`afterAgent` lifecycle hooks, asserts the
  projected source IDs and index labels, and feeds broken Mermaid blocks to prove
  index sync fails on unparseable diagrams.
- `test/agent/wiki-finalizer.test.ts` exercises `prepareWikiForAuthoring` and
  `finalizeWikiArtifacts` against an isolated repository-mode backend, capturing
  the operation sequence (`migrate`, `provenance_snapshot`) and asserting on the
  persisted content written to the real filesystem.
- `test/agent/repository-runner.test.ts` drives `runNativeRepositoryGeneration`
  through a `deepagents`/`repository-run.js` mock harness. It asserts the
  shell-free tool surface and one fresh worker per page, and includes the
  worker-exit/skip regression `restores and leaves a page pending when its worker
  does not submit`: when a page worker exits without calling `submit_page`, the
  runner invokes `captureRepositoryPageSnapshot`/`skipRepositoryPage` to restore
  the captured snapshot, marks that page `skipped`, finishes the run, and emits
  a `text` event telling the user the page will be "reconsidered on the next
  update" — leaving the skipped page to be re-queued as `pending` on resume.
- `test/agent/repository-prompts.test.ts` exercises the planner and page-worker
  prompt builders (`createRepositoryPlannerPrompt`/`createRepositoryPagePrompt`)
  in isolation, asserting that planning context, changed paths, update windows,
  claim issues, and the wiki goal reach the prompt text, that unknown baselines
  render as full-review windows, that page-specific instructions and existing
  Claims propagate into the page-worker prompt (including the "You own exactly
  …" ownership line), and that the complete planned page map is shown only to the
  quickstart page.
- `test/agent/repository-source-fingerprint.test.ts` exercises
  `createRepositorySourceFingerprint`/`createRepositorySourceSnapshot` and
  `getRepositoryChangedPaths` against a real isolated Git repository created with
  `mkdtemp`. It asserts the fingerprint is stable for identical input, changes
  with HEAD, tracked content, staged-vs-unstaged state, deletions, untracked
  files, executable-bit changes, and `.openwikiignore` rules; that symlinks are
  hashed by target string without following the target; that a TOCTOU race where
  an inspected file becomes a symlink before opening fails closed; and that
  generated pages, Claims sidecars, and run metadata are ignored. A
  `vi.hoisted`/`vi.mock` of `node:fs/promises.open` injects the race.
- `test/agent/update-noop.test.ts` exercises `getUpdateNoopStatus` and
  `shouldCheckUpdateNoop` against real `mkdtemp` Git repositories. It covers the
  no-op conditions (unchanged HEAD, dirty-only committed run metadata, a
  migration that only adds the page manifest, OpenWiki-only commits, ignored
  worktree paths, a missing `status` field that still counts as complete) and the
  non-no-op conditions (changed source files, an interrupted previous run, a
  different language request), plus the no-op metadata refresh that preserves the
  persisted language across the fast-skip path.

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

### Generation: planning, page manifest, run state, and the end-to-end run

`test/generation/` mirrors `src/generation/`. It splits the generation subsystem
into pure planning, per-page manifest persistence, run-state persistence, and the
end-to-end repository-run lifecycle:

- `test/generation/page-jobs.test.ts` exercises `createRepositoryPlan` and
  `replacePageClaims`. It covers init/update plan validation (quickstart required
  for init, no init deletions, no quickstart deletion, no duplicate or
  overlapping generate/delete pages, no structural or reserved working pages),
  input normalization (trimming, deduplication, quickstart-last ordering,
  stable UUID assignment), and the claim-issue reconciliation jobs the planner
  inserts for stale/unresolved claims — including the evidence-seed normalization
  and the language-rewrite jobs that avoid duplicating planned or deleted pages.
  The `replacePageClaims` tests drive the code-claim session's add/confirm/
  update/retract/omit reconciliation model, including no-ID exact matches,
  evidence-set normalization, duplicate-proposal rejection, NUL-delimiter
  fingerprint safety, unknown/wrong-page identifier rejection, and atomic
  rollback when evidence resolution fails.
- `test/generation/page-manifest.test.ts` exercises the page manifest's
  persistence and completion-durability primitives
  (`readRepositoryPageManifest`/`writeRepositoryPageManifest`/
  `recordRepositoryPageCompletion`/`seedRepositoryPageManifest`/
  `replaceRepositoryPageManifest`/`isRepositoryPageCompletionCurrent`) against
  real `mkdtemp` directories and a `ClaimsStore`. It asserts stable page order
  with no `.tmp` files left behind, fails-closed on malformed JSON and schema
  extensions (invalid hashes, non-canonical paths, structural pages), preserves
  the original manifest and cleans up when the atomic rename fails, refuses to
  advance an unverified or mismatched Claims page, records the exact source
  checkpoint (git head + source fingerprint + page version) for verified bytes,
  seeds missing verified pages while preserving newer coverage, leaves
  unverifiable legacy pages uncovered during migration, and retains only the
  surviving verified page inventory after a replacement.
- `test/generation/run-state.test.ts` exercises `writeRepositoryRunState`/
  `readRepositoryRunState`/`removeRepositoryRunState` against real `mkdtemp`
  directories. It asserts the complete checkpoint is atomically written and read
  back with no `.tmp` files, that validation failure does not replace durable
  state, that a rename target blocked by an existing directory is preserved with
  its temp file cleaned up, that malformed and schema-extended checkpoints are
  rejected as `invalid_state` (resumable), and that an absent checkpoint returns
  null and removal is idempotent.
- `test/generation/repository-run.test.ts` is the end-to-end integration test
  for the repository generation workflow (detailed below).

### OKF: frontmatter, index, claims verification, and claim sources

`test/okf/` mirrors `src/okf/`. `test/okf/frontmatter.test.ts` is the broadest
OKF frontmatter suite: it covers `normalizeConceptContent` (regenerating
frontmatter for bare pages, repairing optional fields while preserving
producer-defined extensions, stamping a localized concept type), and the
`parseFrontmatterFields`/`renderFrontmatter`/`validateOkfFrontmatter`/
`repairOkfFrontmatter`/`validatePersistedFile` helpers. Sibling files cover
index labels (`test/okf/index-labels.test.ts`), index-sync error paths
(`test/okf/index-sync-errors.test.ts`), claims verification
(`test/okf/claims-verification.test.ts`, which exercises
`synchronizeClaimsVerification`/`rollbackClaimsVerification` against a memory
page store — replacing only OpenWiki events while preserving other verifiers,
removing unjustified OpenWiki events, and normalizing bare human events), and
claim-source projection (`test/okf/claim-sources.test.ts`, which exercises
`synchronizeClaimSources` against a guarded `OpenWikiLocalShellBackend`).

### Ingestion: code-mode setup and connectors

`test/ingestion/code-mode.test.ts` exercises `ensureCodeModeRepoSetup` and
`runCodeModeConnectors` against real `mkdtemp` repositories. The agent-file
tests assert that `AGENTS.md` and `CLAUDE.md` are created with the managed
OpenWiki block, that `CLAUDE.md` is a short reference to `AGENTS.md` rather than a
full copy, that the block is refreshed in place while preserving surrounding
content, that the block is appended after existing content, that the setup is
idempotent, and that orphaned/reversed/duplicate markers are rejected without
changing either file. The workflow tests assert the generated CI workflow pins
the OpenWiki install to a specific version, includes the agent files and workflow
in `add-paths`, wires the LangSmith connector read key into the workflow env,
preserves a customized workflow across re-runs, and emits the correct
provider-specific credential/variable blocks (Copilot, OpenAI-compatible,
Bedrock, OpenAI-ChatGPT). The `runCodeModeConnectors` tests exercise the loop and
fail-open skip path without reaching a real API.

### Integrations: host session manager

`test/integrations/session-manager.test.ts` exercises `HostSessionManager` against
real `mkdtemp` Git repositories. It asserts the ordered five-call lifecycle
(`openwiki_begin` → `openwiki_submit_plan` → `openwiki_next_page` →
`openwiki_submit_page` → `openwiki_finish`), host and producer-identity
validation, nested-path resolution to the canonical Git root, the exact active run
ID requirement, begin-conflict mapping that retains the prior active run,
overlapping-lifecycle rejection that releases the guard, repository lifecycle
failure mapping to bounded host errors, retention of active state after a failed
finish, clearing of active state only after a successful durable finish, a proven
update no-op that clears an older process-local run, and durable queue resumption
across different hosts (one producer begins, a second producer resumes the same
run with the correct completed-page count).

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
  `.graph-overlay` with a scrollable `.legend`.
- `test/visualize/client-interaction.test.ts` is a `@vitest-environment jsdom`
  suite for the browser-only `src/visualize/client.ts` interaction wiring.
  Because `client.ts` touches the DOM and CDN globals at import time, the test
  mounts a minimal DOM matching `page.ts`'s post-#670 layout, replaces the
  third-party globals (`ForceGraph`, `marked`, `DOMPurify`, `mermaid`,
  `ResizeObserver`, `fetch`) with recording stubs, imports the client under
  `data-static-export`, and asserts on the handlers it registers. Its primary
  target is the issue #670 regression: background clicks must not be wired to
  any handler, so clicking blank graph space never clears the reader, while
  node clicks select a page and highlight its sidebar entry.

## Testing patterns you will reuse

- **Dependency injection via `vi.mock` + `vi.hoisted`.** Failure-path tests
  wrap a real module with `vi.mock(..., importOriginal)` and use a hoisted
  counter to inject a failure on the Nth call while otherwise delegating to the
  real implementation. `test/generation/repository-run.test.ts`, for example,
  intercepts `writeLastUpdateMetadata`, `writeRepositoryRunState`, and
  `removeRepositoryRunState` this way to inject metadata-write and run-state
  write/removal failures and prove the runner's recovery behavior. It also
  intercepts `recordRepositoryPageCompletion` and `replaceRepositoryPageManifest`
  to inject page-manifest write/replacement failures and to mutate the source
  tree mid-replacement so the no-op manifest replacement falls through to
  planning. `test/generation/page-manifest.test.ts` uses the same pattern on
  `node:fs/promises.rename` to inject an atomic-rename failure. These tests
  import the source modules directly (e.g. `../../src/okf/frontmatter.ts`,
  `../../src/generation/repository-run.ts`) so the run lifecycle is exercised
  through Vitest's transform without first building `dist/`.
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
`submitRepositoryPage`, `finishRepositoryRun`) and the skip primitives
(`captureRepositoryPageSnapshot`, `skipRepositoryPage`) from
`src/generation/repository-run.ts`, and drives the full begin → submit_plan →
next_page → submit_page → finish lifecycle against a temporary Git repository.
A `failureHarness` created with `vi.hoisted` wraps the real `src/agent/utils.js`,
`src/generation/run-state.js`, and `src/generation/page-manifest.js` modules to
inject failures on selected calls while otherwise delegating to the real
implementation. Each test creates a committed Git repository (via the
`git`/`createRepository` helpers), optionally arms the failure counters in
`beforeEach`, and removes the temporary directories in `afterEach`, so the run's
recovery and rollback paths are exercised against a real repository without
leaving state behind.

The suite also covers the **skip path** for a page whose worker does not submit:
`captureRepositoryPageSnapshot` snapshots the on-disk Markdown and Claims before
the page is mutated, `skipRepositoryPage` restores that snapshot and marks the
page `skipped` (the `restores the exact pending Markdown and Claims snapshot`
test), and `finishRepositoryRun` accepts a `skippedPageSnapshots` list so a
finish-after-skip leaves the original content and Claims in place, drops run
state, and stamps an `interrupted` last-update status. A separate
`resets an interrupted skipped job to pending on resume` test proves that
resuming a run whose first page was skipped re-queues that page as `pending`
rather than carrying the skipped status forward.

The suite covers **durability and resumability** across producer handoffs:
`submitRepositoryPage` does not mark a page complete until both the Claims
sidecar and the run-state checkpoint are durable (the `does not complete a page
until Claims and checkpoint state are durable` test), a page whose manifest write
fails stays pending with the baseline manifest intact, a page whose completion
checkpointing fails stays pending but keeps its durable Claims and current
manifest coverage — and on resume the completed page is attributed to its
original producer. The `preserves per-page provenance across producer handoffs`
test finishes a two-page run split across two producers and asserts each page's
generated provenance and manifest entry carry the producer that completed it. The
`resumes across producers while rejecting mode and language conflicts` test proves
a second producer can resume the same run while a conflicting mode or language
request is rejected, and the `attributes legacy completed work to its original run
producer` test backfills `completedBy` for legacy state missing the field.

The suite also covers the **no-op and update-window** logic: a strict no-op is
returned only for clean updates without claim issues, a Git-clean update with
stale claims is forced into planning, a docs-only commit fast-forwards every
page, a clean page without manifest coverage is routed to full review, and a
no-op manifest replacement that sees the source change mid-replacement falls
through to planning rather than skipping.

## Choosing the narrowest validation per subsystem

Run the smallest slice that would fail if your change is wrong, then run the full
`pnpm test` gate before finishing. Use `pnpm exec vitest run <path>` to scope by
file or directory, or `-t "<name>"` to scope by test name.

- **A single subsystem:** `pnpm exec vitest run test/generation/` (swap in the
  matching directory from the table above).
- **A single file:** `pnpm exec vitest run test/agent/repository-runner.test.ts`.
- **A single connector source:** `pnpm exec vitest run test/connectors/sources/slack.test.ts`.
- **A single named test:** `pnpm exec vitest run test/config -t "treats whitespace-only overrides as unset"`.
- **Ink components:** `pnpm exec vitest run test/cli/components/`.
- **Generation skip/restore path:** `pnpm exec vitest run test/generation/repository-run.test.ts -t "restores the exact pending Markdown and Claims snapshot"` (snapshot restore + `finishRepositoryRun` with `skippedPageSnapshots`) or `-t "resets an interrupted skipped job to pending on resume"` (resume re-queueing).
- **Generation durability/resumability:** `pnpm exec vitest run test/generation/repository-run.test.ts -t "does not complete a page until Claims and checkpoint state are durable"` (Claims + checkpoint durability) or `-t "resumes across producers while rejecting mode and language conflicts"` (cross-producer resume).
- **Page manifest persistence/replacement:** `pnpm exec vitest run test/generation/page-manifest.test.ts` (atomic writes, rename-failure cleanup, completion durability, replacement inventory).
- **Run-state persistence:** `pnpm exec vitest run test/generation/run-state.test.ts` (atomic checkpoint, validation failure, malformed rejection, idempotent removal).
- **Claims reconciliation jobs:** `pnpm exec vitest run test/generation/page-jobs.test.ts -t "adds required Claim-issue jobs"` (stale/unresolved claim jobs) or `-t "replacePageClaims"` (add/confirm/update/retract/omit reconciliation).
- **Source fingerprint:** `pnpm exec vitest run test/agent/repository-source-fingerprint.test.ts` (stability, HEAD/content/exec-bit/ignore changes, symlink race, generated-page exclusion).
- **Update no-op preflight:** `pnpm exec vitest run test/agent/update-noop.test.ts` (no-op conditions, non-no-op conditions, metadata refresh).
- **Repository worker prompts:** `pnpm exec vitest run test/agent/repository-prompts.test.ts` (planner and page-worker prompt content).
- **Agent worker-exit/skip path:** `pnpm exec vitest run test/agent/repository-runner.test.ts -t "restores and leaves a page pending when its worker does not submit"`.
- **Code-mode setup/workflow:** `pnpm exec vitest run test/ingestion/code-mode.test.ts` (agent files, CI workflow generation, provider blocks, connector loop).
- **Host session manager lifecycle:** `pnpm exec vitest run test/integrations/session-manager.test.ts` (five-call lifecycle, resume across hosts, conflict/guard mapping).
- **Visualizer client interaction regression:** `pnpm exec vitest run test/visualize/client-interaction.test.ts` (jsdom; run `test/visualize/` for the full page/graph/client-lib slice).

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
