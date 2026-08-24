---
type: Reference
title: Telemetry
description: OpenWiki's single anonymized run-telemetry boundary — the run event, opt-out and CI gates, the anonymous install id, and the anonymity spine that keeps error detail a closed word set.
tags: [telemetry, privacy, anonymization, gates, operations]
sources:
  - id: openwiki-source-983a7ea90223cb0c0bfc6faa
    resource: repo://src/telemetry/gates.ts
  - id: openwiki-source-7e9934a30a9a1fa29191f619
    resource: repo://src/telemetry/install-id.ts
  - id: openwiki-source-f9a8800e7cfba8f10a6141d0
    resource: repo://src/telemetry/record-run-safe.ts
  - id: openwiki-source-04684180af5ec3c4b1911941
    resource: repo://src/telemetry/taxonomy.ts
  - id: openwiki-source-32254c551f1dd6279c57f228
    resource: repo://src/telemetry/with-run-telemetry.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-22T08:02:55.052Z" }
verified:
  - by: openwiki/0.3.3
    at: 2026-08-22T08:02:55.052Z
---

# Telemetry

OpenWiki records anonymous, opt-out usage telemetry through a single boundary so failures anywhere in a run are captured exactly once and no secret or free text ever leaves the process.

## The single boundary

`withRunTelemetry` is the sole place an `openwiki_run` event is recorded. It wraps the whole setup → connectors → agent sequence, so a failure anywhere in it is recorded once, and rethrows so the CLI still owns the failure UX.

A mutable `RunTelemetryContext` lets the boundary sit **outside** the agent while still attributing the provider and a `noop` short-circuit that are only knowable inside the agent, which writes those facts as they become known. A clean return records the agent's outcome (defaulting to `success`); a throw records `failure` with anonymous diagnostics from `describeErrorForTelemetry`.

Only `init` and `update` runs are recorded — chat is dropped because it is interactive and would emit an event per turn. Setup choices (brain mode, resolved provider, configured connectors) are attached on **init only**, the configuration moment, and omitted from updates.

## Gates

- Sending is **opt-out**: disabled when `OPENWIKI_TELEMETRY_DISABLED` or `DO_NOT_TRACK` is set.
- **CI and scheduled** runs are still sent but collapsed to a per-provider sentinel id so ephemeral runners never inflate human install counts.
- Every event is stamped with a **build channel** (only npm-published upstream builds report `official`) and a **production** flag derived from running out of `dist/`, so fork and local/dev usage can be filtered from the official signal.

## Install id and first-run notice

The install id is a random UUID with no relationship to user, machine, or repository, created on first use with `0600` permissions. Its just-minted state is the only signal for the one-time first-run notice, which is suppressed (and no id minted) when opted out or in CI; the check never throws so telemetry cannot break a run.

## Error anonymity

Error telemetry is anonymized by a **hardcoded per-family `errorDetail` allowlist**: any detail not named for its family is dropped to `undefined`, so only hand-named words leave the process. Two families (`connector_error`, `tool_error`) instead carry a registry id validated at the tag site against the known connector/tool set rather than a fixed-word list.

Secret redaction of any text that does surface is handled by the shared boundary documented in [reference/platform.md](../reference/platform.md).
