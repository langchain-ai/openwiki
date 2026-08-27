---
type: operations-guide
title: Telemetry and Diagnostics
description: How OpenWiki's opt-out telemetry pipeline emits a single anonymous run event per init/update run, how failures are classified into a closed error taxonomy, and how secrets and PII are kept out of the payload before it is sent to PostHog.
tags:
  [
    telemetry,
    diagnostics,
    error-taxonomy,
    posthog,
    privacy,
    opt-out,
    observability,
  ]
verified:
  - by: openwiki/0.3.3
    at: 2026-08-25T02:14:25.283Z
sources:
  - id: openwiki-source-a953060a04ccefcf777de48e
    resource: repo://src/agent/index.ts
  - id: openwiki-source-5c43e3fe562cf274dd6a5564
    resource: repo://src/cli/cli.tsx
  - id: openwiki-source-106c72a9cb6dd904077fc747
    resource: repo://src/cli/runners.ts
  - id: openwiki-source-c6189f89b3f67d0cbf87739f
    resource: repo://src/ingestion/ingestion.ts
  - id: openwiki-source-60556380629632e617d8e7e0
    resource: repo://src/telemetry/client.ts
  - id: openwiki-source-73e38f51cb8534f4fd4cd132
    resource: repo://src/telemetry/config.ts
  - id: openwiki-source-de7a4526fa69e1956c196942
    resource: repo://src/telemetry/errors.ts
  - id: openwiki-source-983a7ea90223cb0c0bfc6faa
    resource: repo://src/telemetry/gates.ts
  - id: openwiki-source-7e9934a30a9a1fa29191f619
    resource: repo://src/telemetry/install-id.ts
  - id: openwiki-source-f9a8800e7cfba8f10a6141d0
    resource: repo://src/telemetry/record-run-safe.ts
  - id: openwiki-source-a59b718eedabd4a3e04f9335
    resource: repo://src/telemetry/senders.ts
  - id: openwiki-source-04684180af5ec3c4b1911941
    resource: repo://src/telemetry/taxonomy.ts
  - id: openwiki-source-391c567087851b17023967bc
    resource: repo://src/telemetry/types.ts
  - id: openwiki-source-32254c551f1dd6279c57f228
    resource: repo://src/telemetry/with-run-telemetry.ts
  - id: openwiki-source-d337a8a4afd2614e0a264fee
    resource: repo://test/telemetry/client-no-key.test.ts
  - id: openwiki-source-142fc9b8e9409b07e4e0761b
    resource: repo://test/telemetry/record-run-safe.test.ts
  - id: openwiki-source-cfe8e85ce6acfbb2cc52e1c1
    resource: repo://test/telemetry/telemetry-install-id.test.ts
  - id: openwiki-source-869aa915b89c011e7c3d9e5c
    resource: repo://test/telemetry/telemetry.test.ts
  - id: openwiki-source-9ba5e33980ba1f452c6884d4
    resource: repo://test/telemetry/with-run-telemetry.test.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-25T02:14:25.283Z" }
---

# Telemetry and Diagnostics

OpenWiki ships an **opt-out**, **anonymous**, **aggregate** usage telemetry
pipeline. It emits exactly one event — `openwiki_run` — per completed `init` or
`update` run, carrying the command, outcome, environment provenance, and (on
failure) a closed-set error classification. No file contents, repository data,
credentials, prompts, model output, IP address, or personal information ever
leave the process. This page documents the gating/opt-out model, the single
run-telemetry boundary, the error taxonomy, the PostHog senders, and the
anonymity guarantees baked into each of them.

The module surface is re-exported from `src/telemetry/index.ts`; the important
pieces are the gates (`gates.ts`), the install id (`install-id.ts`), the run
wrapper (`with-run-telemetry.ts`), the run-fact bridge (`record-run-safe.ts`),
the event builder and sender (`senders.ts`, `client.ts`), and the error
taxonomy (`errors.ts`, `taxonomy.ts`).

## Opt-out and gating

Telemetry is on by default and disabled by an explicit switch. `isTelemetryDisabled`
returns true when either `OPENWIKI_TELEMETRY_DISABLED` or the cross-tool
`DO_NOT_TRACK` environment variable is set to a truthy value ("0", "false", and
empty are treated as unset). When disabled, `recordRun` short-circuits before
building or sending any event.

CI is treated differently from opt-out. `isCiEnvironment` (delegating to
`ci-info`, plus the `OPENWIKI_SCHEDULED` escape hatch) still lets events be
sent, but they are tagged `ci: true` and attributed to a **per-provider
sentinel id** (`ci-<provider>`, e.g. `ci-github-actions`) rather than a unique
install id, so ephemeral runners never inflate the human install count. Only an
explicit opt-out stops sending.

Every event is also stamped with distribution provenance so the dashboard can
separate real usage from noise: `isProductionBuild` (true only when running from
`dist/`, deliberately based on build origin rather than `NODE_ENV`) drives the
`production` flag, and `buildChannel()` reports `"official"` only for
npm-published upstream builds (the release pipeline rewrites the committed
`"community"` value via `scripts/stamp-build-channel.cjs`) so fork-originated
telemetry can be filtered out.

## Install id and the first-run notice

Identity is a **persistent, anonymous per-machine install id**: a random UUID
with no relationship to the user, machine, or repository, stored at
`~/.openwiki/install-id` with owner-only permissions (`0o600`, home dir `0o700`).
`getOrCreateInstallId` mints it lazily on first use and reports `isNew: true`
only on the run that created it.

That `isNew` signal drives the one-time disclosure. `firstRunNoticePending`
returns true only on the first run on a machine, and returns false (minting no
id) when telemetry is disabled or in CI (`noticeSuppressed`). It never throws.
The CLI (`cli.tsx`) calls it once at startup before any event is sent, and
renders the disclosure copy — single-sourced as `FIRST_RUN_NOTICE_BODY`,
`FIRST_RUN_NOTICE_OPT_OUT`, and `FIRST_RUN_NOTICE_VERIFY` in `config.ts` — as an
Ink box in the interactive TUI or plain framed text on stderr for print mode.

## The single run-telemetry boundary

`withRunTelemetry` is the **sole place** an `openwiki_run` event is recorded. It
wraps the whole `setup -> connectors -> agent` sequence a caller performs (see
`cli/runners.ts` and `ingestion/ingestion.ts`), so a throw anywhere in that
sequence — repo setup, connector pull, agent prologue, or the agent itself — is
recorded exactly once, closing the pre-agent coverage holes where a throw
previously reached no telemetry.

It threads a mutable `RunTelemetryContext` through the run. The agent publishes
the resolved `provider` onto it the instant provider resolution succeeds (so a
later failure still attributes the right provider), and publishes a `noop`
outcome when an update short-circuits unchanged. On a clean return the wrapper
records the published outcome (defaulting to `success`); on a throw it records
`failure` with the anonymous diagnostics from `describeErrorForTelemetry`, then
**rethrows** so the CLI still owns the failure UX. Telemetry itself never
throws.

```mermaid
sequenceDiagram
    participant Caller as CLI runner
    participant Wrap as withRunTelemetry
    participant Run as setup + connectors + agent
    participant Desc as describeErrorForTelemetry
    participant Safe as recordRunSafe
    participant Send as recordRun

    Caller->>Wrap: run, command, options, ctx
    Wrap->>Run: await run()
    Run-->>Wrap: resolves (ctx.provider, ctx.outcome set)
    alt clean return
        Wrap->>Safe: outcome success or noop
    else throw
        Wrap->>Desc: classify thrown error
        Desc-->>Wrap: class, detail, owner, stage, status
        Wrap->>Safe: outcome failure plus diagnostics
        Wrap-->>Caller: rethrow original error
    end
    Safe->>Send: RunTelemetry (init only adds setup fields)
    Send-->>Send: gate, build event, capture, tee
```

Caption: one run flows through the single telemetry boundary; a failure is
classified and recorded once, then rethrown to the caller.

`recordRunSafe` is the bridge between the run lifecycle and telemetry. It
**drops chat** (interactive, would emit one event per turn) so only `init` and
`update` produce events, maps the agent output mode to the brain `mode`, and
attaches the setup fields (`mode`, `provider`, `configuredConnectors` from the
connector registry) **on init only** — the configuration moment — omitting them
on updates. Like `recordRun`, it never throws.

## Building and sending the event

`buildRunEvent` is the pure, single source of truth for the `openwiki_run`
payload: given a run's facts and its environment context it returns the exact
event sent to PostHog, performing no IO and reading no process state, so the
production sender and the telemetry seed script cannot drift apart. Setup and
failure fields are spread in only when present, so update payloads and
successful runs omit them entirely. Configured connectors are flattened into
boolean `connector_<id>` properties (present = configured) rather than an array,
making connector adoption a point-and-click dimension.

`recordRun` orchestrates the send: it gates on opt-out, resolves identity
(install id for humans, sentinel for CI), builds the event, captures it, and
optionally tees the exact payload to `--telemetry-file`. It swallows all its own
errors.

The actual send lives in `capture` (`client.ts`). It uses PostHog's
`captureImmediate` — whose returned promise **is** the single HTTP request —
awaited under a `FLUSH_TIMEOUT_MS` (3s) bound, deliberately not the queued
`capture()` + flush-on-`shutdown()` path, which can resolve without the event
landing and silently drop events. Because the CLI emits exactly one event and
exits, the immediate awaited send is both simplest and most reliable. The
timeout guarantees telemetry can never stall a run, and the client is shut down
afterward (also bounded) so the process can exit promptly.

### `--telemetry-file` tee

`recordRun` writes the exact record (including the assembled event) to the path
given by `--telemetry-file` so users can verify what is captured. The write is
security-hardened: it writes to an unguessable, owner-only (`0o600`) scratch
sibling opened with `flag: "wx"` (refusing to open through a pre-planted
symlink) and atomically `rename`s it into place, defeating symlink attacks and
permission leakage in shared directories like `/tmp`. A failed tee logs to
stderr but never fails the run.

## Anonymity envelope

Anonymity is enforced structurally, not by convention:

- **No PostHog person.** Every event sets `$process_person_profile: false`, so
  PostHog never builds a person; unique-install counts still work off the random
  install-id `distinctId`. Person-profile features like retention are forgone.
- **No IP / geo.** The send passes `disableGeoip: true`; the raw client IP is
  additionally discarded server-side by the project's "Discard client IP data"
  setting.
- **Closed-set fields only.** Command, outcome, mode, owner, class, stage, and
  build channel are closed enums; connectors are booleans; version and HTTP
  status are bare values. **Raw error strings, messages, provider strings, and
  free text never enter the payload** — the error path emits only enum members
  and bare integers.

## Error taxonomy

On failure, `describeErrorForTelemetry` produces five fields — `errorClass`,
`errorDetail`, `errorStage`, `errorOwner`, and `httpStatus` — from the thrown
value without ever emitting its message.

**Class (the failure family).** `TelemetryErrorClass` is a closed set
(`config_error`, `filesystem_error`, `provider_error`, `network_error`,
`context_limit_error`, `build_error`, `connector_error`, `okf_error`,
`checkpointer_error`, `tool_error`, `output_error`, `agent_error`, `aborted`).
`agent_error` is the residual bucket for anything that matched no rule and is
the quality meter that should trend toward zero. The class comes from the
**origin tag** when a throw site owned its classification (build/connector/okf/
checkpointer, or a tagged config/tool detail), otherwise from `classifyError`.

**Origin tagging.** `inStage` / `inStageSync` bracket a pipeline stage and stamp
any thrown error with an `ErrorOriginTag` carried on a **non-enumerable symbol**
(so it never serializes into a payload or JSON dump). The tag records the
`stage` (`config -> build -> run -> finalize`) and, for owned families, the
class and detail decided where the error was thrown rather than guessed from a
message. First tag wins, so the innermost origin is preserved as the error
unwinds.

**Chain-walking classification.** Errors are frequently wrapped (framework
envelopes, `cause` chains, `AggregateError`). `unwrapErrorChain` flattens the
error into a nearest-first, cycle-safe, depth-bounded (`MAX_UNWRAP_DEPTH = 32`)
list of links. `classifyError` returns the first link that yields a named class
(so a provider error hidden inside a tool wrapper is recovered), `readErrorOrigin`
returns the first link whose tag names an owned family (so an owned error
re-wrapped by LangChain's `MiddlewareError`, which strands the tag on `.cause`,
keeps its class), and `firstStatusInChain` surfaces the nearest HTTP status even
when the top wrapper carries none.

**The stream-open exception.** A `build_error/stream_open` origin tag is the one
override: that stage is the first provider round trip, so a failure there
carrying a provider signal (a `provider_error` classification, or an HTTP status
paired with any named class) is treated as a disguised provider error and the
raw classification wins over the tag — while a genuine stream-setup failure with
no provider signal keeps its informative tag.

**Detail (the specific failure).** `errorDetail` is the specific failure inside
the family, and it is the **anonymity spine**. `normalizeErrorDetail` validates
each observed detail against `taxonomy.ts`'s hardcoded per-family allowlist
(`FIXED_ERROR_DETAILS`) and drops anything off-list to `undefined` rather than
emitting it raw. Two families (`connector_error`, `tool_error`) carry a registry
id validated at the tag site instead of a fixed word. For the residual
`agent_error` bucket the detail is instead the **innermost error's own name**
(`innermostErrorName`), gated by `isSafeErrorIdentifier` — a bare identifier of
at most 64 chars matching a strict pattern — so a `.name` or `constructor.name`
carrying a path, URL, space, or user value is rejected and the envelope stays
closed.

**Owner (whose fix it is).** `deriveOwner` is the single source of owner truth,
mapping (class, detail, stage) to `environment`, `provider`, `openwiki`,
`unowned`, or `control`. It encodes the cross-owner exceptions PostHog cannot
derive: `provider_error` details `auth`/`quota_exceeded` route to `environment`
(the user's key/account), `network_error` details `dns`/`refused` route to
`environment` (the user's machine), and `filesystem_error` at the `finalize`
stage routes to `openwiki` (our own wiki write path). Owner is emitted so the
health dashboard can roll failures up by who must act.

## Testing

The behavior that matters is exercised under `test/telemetry/`: the event shape
and gating in `telemetry.test.ts` (with `posthog-node` and `ci-info` mocked so
nothing hits the network and CI detection is deterministic), the run wrapper in
`with-run-telemetry.test.ts`, the run-fact bridge in `record-run-safe.test.ts`,
the no-key send path in `client-no-key.test.ts`, and the install-id lifecycle in
`telemetry-install-id.test.ts`.

## Related pages

- [Architecture Overview](../architecture/overview.md)
- [Configuration](./configuration.md)
- [Testing Overview](../testing/overview.md)
