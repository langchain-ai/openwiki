---
type: concept
title: Grounded Claims
description: How OpenWiki grounds generated wiki pages in versioned repository evidence through the Claims model, including the store, session, and runtime split, evidence resolution and staleness detection, and the durability boundary reached at page completion.
tags: [claims, evidence, grounding, provenance, verification, repository, okf]
verified:
  - by: openwiki/0.3.3
    at: 2026-08-25T02:14:25.283Z
sources:
  - id: openwiki-source-4abcc99d4dad36b191736bb7
    resource: repo://src/claims/brains/code/paths.ts
  - id: openwiki-source-3a2496f3cddf91f93a83147d
    resource: repo://src/claims/brains/code/preflight.ts
  - id: openwiki-source-239b2968fb2bcd073e89cedc
    resource: repo://src/claims/brains/code/runtime.ts
  - id: openwiki-source-2408f48009166e2b2c4a2aac
    resource: repo://src/claims/brains/code/session.ts
  - id: openwiki-source-2b28ddc861d155a44b3cc432
    resource: repo://src/claims/brains/code/store.ts
  - id: openwiki-source-e3e84f4f619ba21ea9918ca9
    resource: repo://src/claims/brains/code/types.ts
  - id: openwiki-source-150d513be5c4c81a6f926292
    resource: repo://src/claims/core/mutations.ts
  - id: openwiki-source-e92e45c28fa79eaef316e968
    resource: repo://src/claims/core/resolver-cache.ts
  - id: openwiki-source-962367b575276437455942cc
    resource: repo://src/claims/core/types.ts
  - id: openwiki-source-75ba41da829774fe72b7a0af
    resource: repo://src/claims/evidence/repository/resolver.ts
  - id: openwiki-source-cd8d06edadee75de8637208c
    resource: repo://src/claims/evidence/repository/resource.ts
  - id: openwiki-source-9bac7069736f3ea19ed36748
    resource: repo://src/okf/claim-sources.ts
  - id: openwiki-source-95484b6dcd037757691dcbb2
    resource: repo://src/okf/claims-verification.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-25T02:14:25.283Z" }
---

# Grounded Claims

A **Claim** is one atomic, independently verifiable factual proposition about the
system, backed by one or more pieces of versioned repository evidence. Claims are
the factual backbone of a generated wiki page: each page owns a complete set of
Claims, and OpenWiki tracks whether the source those Claims cite still matches
what was observed when the page was written.

The data model is deliberately small. A `Claim` has a stable OpenWiki-generated
`id`, an atomic `statement`, and one or more `Evidence` records; each `Evidence`
pairs a resolver-owned `resource` identity with an opaque `version` token
captured when the Claim was established.

## Responsibilities and the store/session/runtime split

The code brain under `src/claims/brains/code` separates persistence, run-scoped
working state, and lifecycle orchestration into three cooperating layers.

- **Store** (`ClaimsStore`) is the OpenWiki-owned persistence boundary rooted at
  one repository. It discovers grounded pages, loads and validates sidecars,
  hashes generated Markdown, and atomically writes and deletes sidecars.
- **Session** (`ClaimSession`) holds mutable run-scoped Claim state per page,
  applies mutation batches, exposes model-facing inspection, tracks evidence
  debt, and finalizes durable state through the store.
- **Runtime** (`prepareClaimsRuntime` / `ClaimsRuntime`) wires a store, a
  repository evidence resolver, and preflight results into a session, and
  exposes a single `finalize` entrypoint that persists Claims and synchronizes
  OKF projections.

```mermaid
stateDiagram-v2
    [*] --> Persisted
    Persisted --> Loaded: preflight loadPages
    Loaded --> Stale: evidence version changed
    Loaded --> Unresolved: evidence missing
    Loaded --> Clean: evidence current
    Stale --> Reconciled: confirm or update recheck
    Unresolved --> Reconciled: update evidence
    Clean --> Reconciled: confirm
    Reconciled --> Dirty: mutation applied
    Loaded --> Dirty: add mutation
    Dirty --> Verified: finalize recheck and write
    Dirty --> Retained: not dirty or blocked by debt
    Verified --> [*]
    Reconciled --> Retracted: retract or page deleted
    Retracted --> [*]
```

Claim lifecycle and state transitions from persisted sidecar through preflight
classification, reconciliation, and durable finalization.

## Where Claim state persists

Claim state is not stored inside the generated Markdown. Each grounded page has a
JSON **sidecar** under `openwiki/.claims/`, mirroring the page's path below
`openwiki/` with a `.json` extension. Sidecars are OpenWiki-owned control state:
they carry the persisted schema version, a `pageVersion` hash of the generated
Markdown bytes, the complete `claims` array, and an optional `verification`
event.

Only pages that own factual state receive a sidecar. Structural and reserved
files (`index.md`, `log.md`, `instructions.md`) and anything inside the
`.claims` directory are excluded from grounding, and evidence itself can never
point back at Git metadata or generated `openwiki/` output.

Sidecars are written atomically: the store serializes validated state to a
temporary file and renames it into place, cleaning up the temporary file on
failure so a partial write can never corrupt a sidecar.

## Evidence resources and versions

Evidence is addressed by a canonical `repo://` URI. The resource is a normalized
repository-relative path, optionally followed by a GitHub-style line-range
fragment such as `repo://src/agent/index.ts#L40-L82`. A single-line fragment like
`#L8` is accepted and canonicalized to `#L8-L8`. Parsing rejects paths that
escape the repository, absolute or drive-letter paths, control characters, and
references to `.git` or `openwiki/`.

Resolution is fully deterministic and never involves the model. The
`RepositoryEvidenceResolver` reads the file through a containment gate that
refuses symbolic links and filesystem aliases, then produces an opaque
`version` token. Whole-file evidence is versioned by a SHA-256 hash of the entire
file (`repo-file-v1:sha256:...`). Line-range evidence is versioned by a hash of
the selected content plus resolver-owned relocation anchors
(`repo-lines-v1:sha256:...`), so that when edits move or resize a range the
resolver can relocate the same selected text using its first and last selected
lines and surrounding context, keeping the version stable when the content did
not actually change.

Because versions are content-derived, a version mismatch is exactly a content
change. Resolution returns `null` when a file or range no longer exists, which is
distinct from a version that merely changed.

## Staleness and unresolved detection

Preflight (`runClaimsPreflight`) runs global freshness checks without creating
mandatory agent work. For every persisted Claim it re-resolves each evidence
resource against its recorded prior version and classifies the Claim:

- **unresolved** when any evidence resource no longer resolves; and
- **stale** when every resource still resolves but at least one resolved to a
  different version than the one recorded.

Unresolved takes precedence over stale for a given Claim. Issues are produced in
a deterministic sorted order and carried into the session as `GroundingIssue`
records attached to the owning page. Resolution errors (as opposed to a missing
file) propagate rather than being mistaken for deleted evidence.

A stale or unresolved marker is a **requirement to recheck current source**, not
an instruction to retract. When a Claim is inspected, its issue is surfaced to
the model so the owning page can confirm, update, or retract it against current
code.

## Mutations and reconciliation

The core mutation engine (`applyClaimOperations`) applies an ordered batch of
`add`, `confirm`, `update`, and `retract` operations against a page's complete
Claim set as an all-or-nothing transaction: nothing is mutated until every
operation validates and all evidence resolves. A batch may not target the same
existing Claim id twice, may not reference unknown ids, and rejects evidence that
repeats or resolves to a duplicate resource. `confirm` re-resolves the Claim's
existing evidence to refresh its versions; an `update` that omits evidence
likewise retains and refreshes the current resources.

The session layer wraps this with cross-page ownership: claim identifiers are
globally unique across pages, allocated to avoid collisions, and a batch is
rejected if it would give one id to two pages. Applying any successful mutation
marks only the owning page dirty and clears the grounding issues for the Claim
ids it targeted, so reconciling a stale Claim removes its debt.

Inspection is side-effect-free: it returns cloned, model-facing Claims with the
opaque evidence versions stripped and any preflight issue attached, without
creating a write obligation.

## The durability boundary at page completion

`ClaimSession.finalize` is the boundary where run-scoped Claim state becomes
durable. It only touches pages that actually changed, and each such page must
pass two gates before its sidecar is written:

1. **No evidence debt** — a page with unresolved grounding issues is refused, so
   stale or unresolved Claims cannot be silently persisted as verified.
2. **Evidence still current** — every Claim's evidence is re-resolved one final
   time; if any resource disappeared or changed version since the mutation was
   accepted, the page is not persisted.

Finalization also removes orphaned sidecars (whose pages no longer exist),
deletes sidecars for pages whose Markdown vanished, and removes sidecars for
pages recorded as deleted. Each page's Markdown is hashed before its sidecar is
written so the persisted `pageVersion` describes the exact bytes on disk. A page
finalized with a non-empty Claim set receives a durable `verification` event; a
page whose Claims were fully retracted is persisted without one.

Finalization is best-effort per page: recoverable per-page failures are isolated
as warnings rather than aborting the run, but the runtime treats any warning as a
durability failure and rejects, so an incomplete finalization does not pass
silently.

## OKF projection: sources and verification

After Claims are durable, the runtime projects them into OKF front matter on the
generated pages. Evidence resources become `sources` entries
(`synchronizeClaimSources`): precise line ranges are collapsed to whole-file
`repo://` resources for provenance, OpenWiki-owned entries get deterministic ids
derived from the resource, and independently authored producer `sources` are
retained.

Durable verification is projected into the OKF `verified` field
(`synchronizeClaimsVerification`): only events in the `openwiki/<version>` actor
family are OpenWiki-owned, so human and other producer events survive. Only a
page that is persisted, clean, non-empty, free of evidence debt, and carrying a
verification event is eligible for a machine stamp.

The projection can rewrite code-owned front matter, which changes the Markdown
bytes and therefore the page hash. To keep sidecars consistent with the final
bytes, `refreshPageVersions` re-hashes represented pages after projection; if a
page whose stamp was newly exposed cannot be refreshed, the verification stamp is
rolled back so a stamp never outlives an accurate `pageVersion`.

## Preparation, resolver caching, and configuration

`prepareClaimsRuntime` is active only for `repository` output outside `chat`
mode. A fresh `init` starts from empty Claim state while still discovering
existing sidecars as orphan candidates; updates and resumed inits run full
preflight first. The repository evidence resolver is constructed with the
repository root and the shared `.openwikiignore` read-boundary rules, so evidence
resolution honors the same exclusions as the agent's file reads.

Every processing phase — preflight, one mutation batch, and one finalization
pass — wraps the resolver with a fresh `cacheEvidenceResolver` so each
`(resource, previousVersion)` pair resolves at most once within that phase while
never caching across a freshness boundary.

## Related pages

- [Source Map](/openwiki/architecture/source-map.md)
- [OKF Output](/openwiki/concepts/okf-output.md)
- [Claims Reconciliation](/openwiki/workflows/claims-reconciliation.md)
- [Repository Generation](/openwiki/workflows/repository-generation.md)
