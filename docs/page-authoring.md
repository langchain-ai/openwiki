# Claims, sections, and prose bindings

OpenWiki connects code evidence to claims, and claims to specific passages in a
wiki page. Sections give those passages stable context and an authored scope
description. The author writes ordinary Markdown and submits metadata through the
existing page-completion tool; OpenWiki owns IDs, validation, and persistence.

## Storage and identities

For `openwiki/transactions.md`, the existing
`openwiki/.claims/transactions.json` sidecar stores `claims`, `sections`, and
`bindings` together. A section contains `id`, `location`, and `description`. A
binding contains `id`, `sectionId`, exact `text`, and `claimIds`.

Claim, section, and binding IDs remain stable across revisions. Renaming a
heading changes its section location once; bindings continue to reference the
section ID. Update descendant section locations too when their heading ancestry
changes, retaining their IDs. A claim can appear in several passages, and a
passage can express several claims.

Existing schema-v1 sidecars without sections and bindings remain readable and
are preserved until their page is actively submitted. A submitted page must
establish the missing metadata. Reading legacy state does not regenerate it.

## Authoring a page

Write OKF titles and descriptions to help a future agent choose pages by subject,
scope, and the questions they answer. Maintain section descriptions for the same
purpose. Retrieval returns these authored fields directly; it does not generate
summaries during reads.

For quickstart, place a short repository summary immediately below its opening
heading, before the next heading. Explain the repository's purpose, major parts,
and their relationships. Put navigation and other details under later headings.
`openwiki_orient` uses this introductory prose as its repository overview. See
[retrieval](retrieval.md) for the complete tool contract.

Suppose the current page job writes:

```markdown
# Transactions

## Failure Handling

Retries are limited to three attempts.
```

The host calls `openwiki_submit_page` with its `runId` and `jobId` plus the
following fields. Native generation uses the same fields on `submit_page`, with
run and job identity supplied by the worker.

```json
{
  "claims": [
    {
      "statement": "Writes get at most three attempts.",
      "evidence": [{ "resource": "repo://src/retry.ts#L12-L20" }]
    }
  ],
  "sections": [
    {
      "location": "transactions.md#Transactions",
      "description": "Transaction execution and failure behavior."
    },
    {
      "location": "transactions.md#Transactions#FailureHandling",
      "description": "Limits on failed write attempts."
    }
  ],
  "bindings": [
    {
      "section": "transactions.md#Transactions#FailureHandling",
      "text": "Retries are limited to three attempts.",
      "claims": ["Writes get at most three attempts."]
    }
  ]
}
```

New records omit `id`; OpenWiki allocates it. A proposed binding uses `section`
and `claims` so it can reference a section's exact location or a new claim's exact
statement before generated IDs are known. Existing IDs are also accepted. An
ambiguous statement requires an explicit claim ID. Persisted bindings always use
resolved `sectionId` and `claimIds`.

`openwiki_next_page` supplies current sections, a binding count, and the bindings
connected to claims requiring evidence review. `openwiki_inspect_page_claims`
returns the current pending page's complete claims, sections, and bindings when
an author needs IDs for a broader edit. Its native equivalent is `inspect_claims`.

## Section locations and exact passages

A location is a wiki-relative page followed by heading ancestry separated by
`#`. Each heading component preserves case and inline Markdown syntax, removes
whitespace, and uses JavaScript `encodeURIComponent` escaping. For example,
`## C# 100%` under `# Languages` maps to
`languages.md#Languages#C%23100%25`. This is an OpenWiki locator, not a browser
fragment.

Both ATX and setext headings are recognized. Heading-like text inside code,
quotes, lists, or HTML does not create a section. An introduction before the
first heading uses the page path alone. Every section, including a heading with
no direct prose, needs an authored description.

Bindings match the exact Markdown text in a section's direct body. They exclude
the heading and nested sections, and never match YAML frontmatter. Line endings
are normalized to LF; other whitespace remains significant. Missing or repeated
passages and ambiguous heading paths produce correction feedback rather than a
fuzzy or positional match.

## Incremental updates

Submit only additions, revisions, and removals:

| Record  | Add or revise                                       | Remove              |
| ------- | --------------------------------------------------- | ------------------- |
| Claim   | `claims`; include its existing `id` for revisions   | `retractedClaimIds` |
| Section | `sections`; include its existing `id` for revisions | `removedSectionIds` |
| Binding | `bindings`; include its existing `id` for revisions | `removedBindingIds` |

Use `confirmedClaimIds` for stale claims rechecked and retained unchanged.
Untouched, issue-free claims and omitted prose metadata remain in place. Each
section or binding revision supplies its complete editable fields; it does not
need to repeat neighboring records.

When evidence changes, review the claim and all its bound passages. Confirm,
revise, or retract the claim, then keep, revise, or remove the affected prose and
bindings. Review section descriptions when scope changes. A description that
still fits can remain unchanged.

## Validation and retry

Before changing session state, OpenWiki validates the resulting claims, sections,
and bindings together against the finished Markdown. Every retained claim needs
a binding; every binding must reference existing claims and a uniquely located
section containing its exact passage. Retained records are validated too.

Correctable failures return tool feedback and keep the page pending. Invalid
prose metadata does not install claim revisions or clear stale evidence issues.
Correct the page or sparse submission and retry. Previously completed pages stay
intact. Exact repeated additions and already-applied removals are safe to retry
after persistence succeeds but a later completion checkpoint fails.

The existing atomic sidecar write persists claims and prose metadata together.
Page completion proves that the metadata and page hash are durable, including
after verification frontmatter is projected. Skipped-page recovery preserves the
original Markdown and complete sidecar.

Structural validation proves that references resolve, not that a claim is true
or a description fits. The author remains responsible for that judgment against
code and tests. Supported edits go through page submission; special recovery for
direct external wiki edits is deferred.
