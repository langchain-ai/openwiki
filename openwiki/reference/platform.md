---
type: Reference
title: Platform Utilities & Redaction
description: Cross-cutting platform helpers — the single secret-redaction boundary, output-language validation, Windows ACL restriction mirroring POSIX 0700, and shared filesystem error classifiers.
tags: [platform, redaction, security, language, filesystem]
sources:
  - id: openwiki-source-04a008dbe4969919f7141a55
    resource: repo://src/platform/diagnostics.ts
  - id: openwiki-source-2f1e489d53c52a0582582659
    resource: repo://src/platform/fs-errors.ts
  - id: openwiki-source-349c953869b025f9d4935470
    resource: repo://src/platform/language.ts
  - id: openwiki-source-27fbd70857f0fae28185fe91
    resource: repo://src/platform/windows-acl.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-22T08:02:55.052Z" }
verified:
  - by: openwiki/0.3.3
    at: 2026-08-22T08:02:55.052Z
---

# Platform Utilities & Redaction

The platform layer holds cross-cutting helpers used throughout OpenWiki. The most important is the single secret-redaction boundary that every diagnostic path routes through.

## Secret redaction

`sanitizeDiagnosticText` is the **single** secret-redaction boundary: any error message, header value, or provider response body that could contain a credential must pass through it before being shown or logged. It removes both the exact values of secrets currently set in the environment for the known provider key names, and anything matching known key/token shapes (`sk-…`, `sk-or-v1-…`, `Bearer …`, LangSmith `ls…` tokens, and the "Incorrect API key provided: …" phrasing).

A single `SECRET_KEY_PATTERN_SOURCE` names the substrings that mark an object key as secret-bearing and is the one source of truth shared by every redaction path — diagnostics, provider response bodies, and MCP tool args/results. Extend that pattern, not the individual call sites.

Consumers include the agent stream/error redaction, mermaid error sanitization, MCP transport sanitization, and CLI diagnostics.

## Output language

`resolveLanguage` validates and canonicalizes an output-language flag using only built-in `Intl` APIs (no dependency added). It distinguishes recognized codes from structurally valid but unknown ones; an unrecognized value resolves to no language plus a warning, so callers fall back to English rather than persisting garbage.

## Windows ACL

`restrictDirToCurrentUser` mirrors the POSIX `0700` owner-only intent on Windows, where `fs.chmod` only toggles the read-only attribute. It uses `icacls` to grant full control to the current user and SYSTEM before resetting inheritance, so a failed grant cannot lock the user out. It is best-effort — returning `false` instead of throwing so ACL tooling problems never block a run — and a no-op on non-Windows platforms.

## Filesystem error classifiers

Shared classifiers give a single source of truth: `isFileNotFoundError` matches `ENOENT`, and `isExpectedSnapshotRaceError` treats `EISDIR`/`ENOENT`/`ENOTDIR` as skip-this-entry races during tree scans rather than fatal errors.
