---
type: Reference
title: Claims Evidence (repo:// Resources)
description: The repository evidence namespace behind Grounded Claims — repo:// resource identities, whole-file and line-range versioning, anchor-based range relocation, and the containment and symlink security boundary.
tags: [claims, evidence, repository, versioning, security]
sources:
  - id: openwiki-source-239b2968fb2bcd073e89cedc
    resource: repo://src/claims/brains/code/runtime.ts
  - id: openwiki-source-962367b575276437455942cc
    resource: repo://src/claims/core/types.ts
  - id: openwiki-source-75ba41da829774fe72b7a0af
    resource: repo://src/claims/evidence/repository/resolver.ts
  - id: openwiki-source-cd8d06edadee75de8637208c
    resource: repo://src/claims/evidence/repository/resource.ts
  - id: openwiki-source-b29e22b2bea9905b27e8e8e8
    resource: repo://test/claims/evidence/repository/resolver.test.ts
generated: {by: "openwiki/0.3.3", at: "2026-08-24T23:37:28.906Z"}
verified:
  - by: openwiki/0.3.3
    at: 2026-08-24T23:37:28.906Z
---

# Claims Evidence (`repo://` Resources)

Every Claim is backed by **evidence**: a stable resource identity plus an opaque version token. The only supported evidence namespace is the repository, resolved deterministically by `RepositoryEvidenceResolver` without any model involvement. The resolver implements the generic `EvidenceResolver` contract — `resolve(resource, previousVersion?) → ResolvedEvidence | null` — and is the sole concrete resolver wired into the Claims runtime.

## The `repo://` resource

An evidence resource is a `repo://` URI naming a repository-relative path, optionally with a GitHub-style line fragment:

- `repo://path/to/file.ts` — whole-file evidence.
- `repo://path/to/file.ts#L10-L24` — a bounded, language-agnostic line range.

A single-line fragment such as `#L8` is accepted as input and **canonicalized** to `#L8-L8`. Path segments are percent-encoded/decoded (so a literal `#` inside a filename is escaped as `%23`), and a resource is re-parsed after formatting to guarantee it round-trips to a single canonical form.

Parsing rejects anything that would let evidence point outside the intended surface: control characters, invalid percent-encoding, absolute or drive-letter paths, `..` traversal, and — explicitly — `.git` metadata or the generated `openwiki/` output. A line fragment must match `L<start>` or `L<start>-L<end>` with `end >= start` and safe integers.

## Versioning

Evidence versions are opaque, algorithm-prefixed SHA-256 tokens so staleness is a simple version-string comparison:

- **Whole-file** evidence versions (`repo-file-v1:sha256:...`) hash the complete file text.
- **Line-range** evidence versions (`repo-lines-v1:sha256:...`) hash the selected range **and embed resolver-owned anchors** — the selected line count plus hashes of the first/last selected lines and the preceding/following context (up to three lines on each side). These anchors are base64url-encoded into the opaque version so the resolver can relocate a range later without any external index.

```mermaid
flowchart TD
    Res["repo:// resource + prior version"] --> Parse["parse & canonicalize"]
    Parse --> Guard{"ignored / traversal /<br/>.git / openwiki?"}
    Guard -- yes --> Err["throw resource error"]
    Guard -- no --> Read["lstat + realpath<br/>contained regular file"]
    Read -- symlink/alias --> Sec["throw security error"]
    Read -- missing/non-regular --> Null["return null"]
    Read -- file --> Kind{"has line range?"}
    Kind -- no --> Whole["whole-file version<br/>(hash entire file)"]
    Kind -- yes --> Locate["relocate range via anchors"]
    Locate -- unchanged --> Keep["reuse prior version"]
    Locate -- moved/resized --> New["re-anchor + new version"]
    Locate -- unlocatable/ambiguous --> Null
```

_Resolving one `repo://` resource to current evidence._

## Range relocation

Line-range evidence survives ordinary edits. When a prior version is supplied, the resolver parses its embedded anchors and relocates the range:

- if the selected range is **unchanged** at (or near) its hinted location, the prior version is reused verbatim;
- if the range **moved or resized**, the resolver locates the changed span via its preceding/following context anchors and re-anchors it into a new version;
- if the range can no longer be located safely, resolution returns `null` (treated as unresolved).

Two invariants keep relocation trustworthy:

- **Ambiguity aversion.** When more than one candidate span matches the prior anchors, the resolver returns `null` rather than guessing. An unchanged range that appears in multiple places is only kept when its surrounding context uniquely identifies one occurrence; a changed range bounded by ambiguous context anchors resolves to nothing instead of binding evidence to the wrong location.
- **Forward-compatible fallback.** An unknown or unparseable prior version algorithm is ignored, and the range is resolved fresh at its URI line hint. Unrecognized version formats therefore degrade to a normal re-resolution instead of failing, so a future version scheme does not invalidate older evidence.

Source is split into exact lines that retain their terminators, and a terminal newline does not create a phantom trailing line, so hashing is stable across platforms. A requested range whose end line exceeds the current file length resolves to `null`.

## Security boundary

The resolver enforces containment at multiple layers before reading any file:

- a `.openwikiignore` match throws rather than silently resolving, so evidence cannot cite an excluded path;
- the target is `lstat`-ed and a **symbolic link is refused**, and the `realpath` must equal the expected physical path inside the physical repository root — defeating alias/symlink traversal (including parent-directory symlinks that point inside the repo and case-variant filesystem aliases);
- a genuinely missing file (or a non-regular file such as a directory) resolves to `null` (deleted evidence), distinct from a security violation, which throws.

The resolver shares the same `.openwikiignore` rules as the agent (see [../agent/backend.md](../agent/backend.md)), so the read boundary is consistent across the whole system. For how versions are compared and cached per processing phase, see [runtime-and-store.md](runtime-and-store.md); for the Claims concept and lifecycle, see [overview.md](overview.md).
