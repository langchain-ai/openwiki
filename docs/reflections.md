# Repository reflections

A reflection preserves useful repository knowledge that future agents would
otherwise need to rediscover. It records what was learned, when it applies, and
evidence another agent can check.

Investigation, implementation, debugging, and review can all produce reflections.
Record a verified discovery before finishing when the wiki and pending reflections
do not already capture it accurately. This does not require a code change, a PR,
or a wiki error.

For example, “I changed the retry limit” is a task summary. “The retry limit
includes the initial attempt, so a limit of three permits at most two retries”
is reusable knowledge. Cite the attempt counter and its boundary test. Other
examples include undocumented behavior, component relationships, constraints and
invariants, verified failure causes, evidence-backed decision context, workflow
knowledge, consequences of changes, and corrections. These examples are not
exhaustive; usefulness, evidence, and whether the knowledge is already captured
determine what belongs. Skip speculation and duplicate findings.

## Capture

Call `openwiki_reflect` independently of generation runs:

```json
{
  "root": "/path/to/repository",
  "finding": "The retry limit includes the initial attempt. A limit of three permits at most two retries.",
  "evidence": [
    { "resource": "repo://src/retry.ts#L12-L20" },
    { "resource": "repo://test/retry.test.ts#L30-L45" }
  ]
}
```

`root` must be the absolute Git repository root. Supply a non-empty finding and
at least one distinct evidence resource. OpenWiki resolves files and line ranges
against the current checkout, honors `.openwikiignore`, and captures evidence
versions. Missing, ignored, invalid, or aliased evidence returns correction
guidance without publishing a reflection. Correct the input and retry the same
tool; the MCP connection remains usable.

The response identifies the artifact without echoing the finding:

```json
{
  "id": "reflection-550e8400-e29b-41d4-a716-446655440000",
  "path": "openwiki/.reflections/reflection-550e8400-e29b-41d4-a716-446655440000.json"
}
```

Include that file with the task's changes. It becomes available to retrieval
immediately and can travel through a PR. OpenWiki does not commit it automatically.
Captured evidence versions support later rechecking; they do not certify truth.

## Stored record

Each reflection occupies one immutable JSON file under `openwiki/.reflections/`:

```json
{
  "id": "reflection-550e8400-e29b-41d4-a716-446655440000",
  "finding": "The retry limit includes the initial attempt. A limit of three permits at most two retries.",
  "evidence": [
    {
      "resource": "repo://src/retry.ts#L12-L20",
      "version": "<captured evidence version>"
    },
    {
      "resource": "repo://test/retry.test.ts#L30-L45",
      "version": "<captured evidence version>"
    }
  ]
}
```

OpenWiki owns IDs and versions. There are no authors, timestamps, tags, status
fields, or shared index. Conditions belong in the finding. Create new discoveries
through the tool; do not edit existing records.

UUID filenames let independent additions merge as separate files. Publication is
atomic and refuses to replace an existing file, including an unlikely UUID
collision. Concurrent calls can record the same discovery under different IDs.
An uncertain response followed by a retry can also create a duplicate; check for
the artifact before retrying. Semantic deduplication belongs to consolidation.

## Retrieval and lifecycle

The [retrieval guide](retrieval.md) documents the response shapes. Locally present
records found in main's current or historical snapshots appear in
`shortTerm.reflections`; new branch or local records appear in
`working.reflections`. A file pulled from main is short-term even before its
commit is merged into the branch. Main-only files absent from the checkout are
not retrieved. Each readable finding appears once in a response.

Orient includes every local discovery, including those without known wiki links.
Outline narrows to the requested page; read narrows to the returned sections.
Connections follow shared evidence file paths through claims, bindings, and
sections. They indicate relevance without asserting agreement or contradiction.
Read exposes evidence resources; captured versions stay in storage.

Retrieval reads pending records even if their cited code has changed or vanished.
Verify their evidence before relying on them. Source comparison failures do not
hide reflections. Unknown origins and inventory gaps are explained by the optional
`unclassifiedReflections` fallback; unreadable files do not hide valid neighbors.

Every update evaluates the reflections present when it starts, including on a
branch and when source code is unchanged. Reading a reflection or merging it into
main does not consolidate it. The update uses the normal planner and page authors
to verify, deduplicate, incorporate, or discard findings, then deletes successfully
processed files. Later arrivals wait for the next update.

## Consolidation through the existing update workflow

`openwiki_begin({ root, mode: "update" })` returns the captured pending discoveries
in `reflections`. Each entry contains `id`, `finding`, and `evidence`. Evidence
entries contain the resource and, when applicable, `issue: "changed"` or
`issue: "unresolved"`. Opaque captured versions stay in storage. These markers
guide investigation; they do not decide whether a finding is true.

The planner checks every finding against source and existing knowledge. Assign
useful or already-represented findings to one canonical page, grouping related
discoveries and duplicates. Add a page when the knowledge has no suitable home.
Schedule other needed page corrections through the same plan.

```json
{
  "runId": "<active run ID>",
  "pages": [
    {
      "path": "/openwiki/concepts/retries.md",
      "title": "Retries",
      "purpose": "Explain attempt counting and retry limits.",
      "reflectionIds": ["reflection-550e8400-e29b-41d4-a716-446655440000"]
    }
  ],
  "discardedReflectionIds": []
}
```

Every pending captured ID must appear exactly once across page assignments and
`discardedReflectionIds`. The latter is for findings verified as unsupported,
obsolete, or incorrect during planning. If all findings are discarded and no
other work is needed, `pages: []` is valid. OpenWiki validates and saves the plan
before deleting planner discards. No additional consolidation tool is needed.

`openwiki_next_page` returns the current job's pending `reflections`, with the
same evidence feedback. The author checks them against current code and makes
the ordinary sparse claim, section, and binding changes described in
[page authoring](page-authoring.md). Alongside those changes, submit:

```json
{
  "reflectionResults": [
    {
      "id": "reflection-550e8400-e29b-41d4-a716-446655440000",
      "claims": ["The retry limit includes the initial attempt."]
    }
  ]
}
```

This fragment belongs in `openwiki_submit_page` with the run and job IDs and any
necessary page reconciliation fields. `claims` references resulting claim IDs
or exact new statements bound to the finished prose. Use the existing claim ID
when the proposition already exists, or the exact statement of a new claim in
the same submission. Several reflections may reference the same claim; no
redundant claim or explanation is required. Use `claims: []` only for a finding
discarded after verification. Every pending assigned finding requires one result.

Results are checked against the complete prospective page before its claim state
is changed. Missing outcomes, unknown or ambiguous claim references, and invalid
prose links return correction guidance. After validation, OpenWiki persists and
proves the page, claims, sections, and bindings before deleting the processed
reflections. The same contracts apply to native OpenWiki generation.

## Recovery and the starting set

The existing `openwiki/.run.json` captures `initialReflectionIds` and each page's
`reflectionIds` so a resumed update keeps its original scope. These are input
scope and ordinary queue assignments. Reflection results are never persisted;
there is no outcome registry, reflection-to-claim mapping, processing log, or
archive. The pending files remain the work to process, and the run checkpoint is
removed on successful finish. Runs started before this capability leave their
reflections for the next new update.

If a page fails or is skipped, its findings remain pending. Finish refuses to
complete while any captured reflection remains, preserving the run for resume.
Call begin again to retry skipped jobs. Findings added during the run are excluded
from that check and stay available to retrieval until the next update.

If persistence succeeds but deletion fails, the page remains saved and undeleted
findings remain pending. Resume, inspect the page, and recognize already-incorporated
knowledge as a duplicate. Partial deletion does not require repeating outcomes
for files already gone. Page completion is recorded after deletion, so recovery
cannot advance past unfinished consolidation based on a page manifest alone.

Malformed captured files stop consolidation with an explanation; they are never
silently treated as processed. Restore valid files and retry. Source drift
invalidates the plan through the existing lifecycle and replans only the captured
findings still present. No historical outcome record is needed.
