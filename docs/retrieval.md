# Repository memory retrieval

Use OpenWiki's MCP tools to find relevant repository knowledge and follow its
claims back to code. The tools read maintained wiki content without invoking a
model, creating metadata, or starting a generation run. Each tool works
independently; an agent that knows a page can read it directly.

All inputs use the absolute Git repository root. Page paths are relative to
`openwiki/` and pass unchanged between tools. Every response has three layers:

- `longTerm`: the consolidated knowledge for the tool's scope.
- `shortTerm`: changes on main since the relevant wiki source checkpoint, plus
  locally present reflections already shared on main.
- `working`: the resulting branch and local working-tree changes, plus new
  branch or local reflections.

The prose remains as authored. Change connections identify evidence to review;
they do not assert that the supporting claims are false. Reflections are
provisional findings to verify against their evidence. An optional
`unclassifiedReflections` object preserves readable findings when their origin
cannot be established and explains gaps in the local reflection inventory.

## Orient

Call `openwiki_orient` with `{ "root": "/path/to/repository" }`:

```json
{
  "longTerm": {
    "overview": "Acme runs background jobs through a queue and worker pool.",
    "pages": [
      {
        "page": "concepts/jobs.md",
        "title": "Job lifecycle",
        "description": "Job execution, retry limits, and cancellation."
      },
      {
        "page": "quickstart.md",
        "title": "Quickstart",
        "description": "Repository purpose, major components, and a guide to the wiki."
      }
    ]
  },
  "shortTerm": {
    "changes": [
      {
        "resource": "repo://src/retry.ts",
        "inCheckout": true,
        "affectedPages": ["concepts/jobs.md"]
      }
    ],
    "reflections": []
  },
  "working": {
    "changes": [
      {
        "resource": "repo://src/retry.ts",
        "affectedPages": ["concepts/jobs.md"]
      }
    ],
    "reflections": [
      {
        "id": "reflection-550e8400-e29b-41d4-a716-446655440000",
        "finding": "The retry limit includes the initial attempt; configure three for two retries.",
        "relatedPages": ["concepts/jobs.md"]
      }
    ]
  }
}
```

The directory includes all factual Markdown pages in stable path order, including
quickstart. It excludes structural `index.md`, `instructions.md`, and `log.md`
files and the `.claims` directory. The tool accepts no query or ranking options.

The overview is the direct introductory prose below quickstart's opening heading,
ending at the next heading. If the page begins with unheaded prose, that preamble
is the introduction instead. The tool removes surrounding whitespace and returns
the authored Markdown. An empty introduction produces feedback to update
quickstart; it does not substitute a later section or the frontmatter description.

Page titles and descriptions come directly from OKF frontmatter. They must be
non-empty strings. Authors maintain them as navigation: name the subject and
explain which questions the page answers.

## Outline

Call `openwiki_outline` with
`{ "root": "/path/to/repository", "page": "concepts/jobs.md" }`:

```json
{
  "longTerm": {
    "page": "concepts/jobs.md",
    "title": "Job lifecycle",
    "description": "Job execution, retry limits, and cancellation.",
    "sections": [
      {
        "id": "section_jobs",
        "location": "concepts/jobs.md#Jobs",
        "title": "Jobs",
        "description": "Job execution and lifecycle."
      },
      {
        "id": "section_retries",
        "location": "concepts/jobs.md#Jobs#Retries",
        "title": "Retries",
        "description": "Execution attempt limits."
      }
    ]
  },
  "shortTerm": {
    "changes": [
      {
        "resource": "repo://src/retry.ts",
        "inCheckout": true,
        "affectedSectionIds": ["section_retries"]
      }
    ],
    "reflections": []
  },
  "working": {
    "changes": [
      {
        "resource": "repo://src/retry.ts",
        "affectedSectionIds": ["section_retries"]
      }
    ],
    "reflections": [
      {
        "id": "reflection-550e8400-e29b-41d4-a716-446655440000",
        "finding": "The retry limit includes the initial attempt; configure three for two retries.",
        "relatedSectionIds": ["section_retries"]
      }
    ]
  }
}
```

Sections are flat and ordered as they appear in Markdown. Locations express
heading ancestry; use stable IDs as selectors. Titles come from Markdown and
descriptions from the maintained sidecar. An unheaded introduction has an empty
title and uses the page path as its location. Headings without direct prose are
still sections.

## Read

Call `openwiki_read` with
`{ "root": "/path/to/repository", "page": "concepts/jobs.md", "sections": ["section_retries"] }`:

```json
{
  "longTerm": {
    "page": "concepts/jobs.md",
    "sections": [
      {
        "id": "section_retries",
        "location": "concepts/jobs.md#Jobs#Retries",
        "content": "## Retries\n\nJobs receive three attempts.\n"
      }
    ],
    "bindings": [
      {
        "id": "binding_attempts",
        "sectionId": "section_retries",
        "text": "Jobs receive three attempts.",
        "claimIds": ["claim_attempts"]
      }
    ],
    "claims": [
      {
        "id": "claim_attempts",
        "statement": "A job receives at most three execution attempts.",
        "evidence": [
          {
            "resource": "repo://src/retry.ts#L12-L20"
          }
        ]
      }
    ]
  },
  "shortTerm": {
    "changes": [
      {
        "resource": "repo://src/retry.ts",
        "inCheckout": true,
        "affectedClaimIds": ["claim_attempts"]
      }
    ],
    "reflections": []
  },
  "working": {
    "changes": [
      {
        "resource": "repo://src/retry.ts",
        "affectedClaimIds": ["claim_attempts"]
      }
    ],
    "reflections": [
      {
        "id": "reflection-550e8400-e29b-41d4-a716-446655440000",
        "finding": "The retry limit includes the initial attempt; configure three for two retries.",
        "evidence": [
          {
            "resource": "repo://src/retry.ts#L12-L20"
          }
        ],
        "relatedClaimIds": ["claim_attempts"]
      }
    ]
  }
}
```

Omit `sections` to read the whole page; an empty selection is rejected. Selecting
a parent includes its descendants as separate entries in document order. Each
entry contains its original heading and direct Markdown body with LF line
endings. Overlapping selectors do not duplicate sections. An unheaded
introduction selects only its own prose.

Only bindings owned by returned sections and their referenced claims are
included. A claim appears once even when several bindings reference it. Evidence
resources direct further source investigation; internal evidence versions remain
in the sidecar. Reading does not revalidate claims against current code.

Change entries identify source files whose connected claims need verification.
Inspect the returned resources or use native Git tools for the actual changes;
retrieval does not include patches. When `inCheckout` is false, inspect the
relevant main history as well as local code. Binary changes retain their resource
references. Renames appear as deletion and addition, so old evidence remains
connected to the removed path and new paths remain discoverable through orient.

## Source comparisons

OpenWiki uses locally available Git history and never fetches during retrieval.
It uses origin's symbolic default branch when known, otherwise `main` or `master`.
When the local and origin-tracking tips are comparable, it uses the newer one. If
they diverge, the comparison is unavailable until that ambiguity is resolved.

Short-term comparisons use each page's checkpoint in
`openwiki/.page-manifest.json`, falling back to the existing `.last-update.json`
checkpoint for legacy pages without an entry. An explicit page entry without a
commit stays unavailable. Different page checkpoints are respected after partial
updates. Orientation also includes the whole-wiki comparison so new or uncovered
source changes remain visible with `affectedPages: []`.

Each checkpoint is compared to main from their shared ancestor. Working changes
are the net difference between the checkout's shared ancestor with main and the
current working tree. Branch commits, staged edits, unstaged edits, and untracked
files all contribute to that final state. An upstream addition missing from an
older branch is therefore not mistaken for a local deletion. Generated wiki
files and `.openwikiignore` exclusions are omitted; Git-ignored untracked files
are omitted too.

`inCheckout` means all main commits contributing to that resource's change are
reachable from the checkout's HEAD. If only part of the change is incorporated,
it is `false`. Local edits may subsequently change the same file without changing
this history result. The comparison does not infer incorporation from identical
contents or equivalent cherry-picked patches.

Connections follow evidence file paths through claims and bindings. They are
conservative: a change outside a claim's cited line range can still flag that
file's claims for review. `orient` includes unconnected resources; `outline`
includes connections to the requested page; `read` includes only connections to
returned sections and descendants. None of these connections proves a claim false.

A checked layer with no changes returns `changes: []`. An unavailable comparison
returns a reason in place of that list. Reflections are evaluated independently
and remain in the layer even when its source comparison is unavailable:

```json
{
  "shortTerm": {
    "unavailable": "The wiki checkpoint is missing from local Git history. Fetch the required history and retry.",
    "reflections": []
  },
  "working": {
    "changes": [],
    "reflections": []
  }
}
```

Missing checkpoints, shallow history gaps, ambiguous ancestry, unreadable source
metadata, and unresolved working-tree conflicts are reported explicitly. One
unavailable layer does not hide another layer that can be checked or discard
readable `longTerm` content. Git queries are bounded to ten seconds and 8 MiB of
output each; exceeding a bound makes the layer unavailable rather than silently
truncating its changes. Retrieval does not alter the repository, index, or refs.

## Pending reflections

Use [`openwiki_reflect`](reflections.md) to record a useful repository discovery
with evidence. Both `shortTerm` and `working` always have a `reflections` array. Only files
present in the checkout are retrieved, including untracked or pulled files.
Each readable finding appears once. Presence of the exact record in main's
current or historical snapshots establishes short-term origin; new records
absent from complete main history are working memory. An older branch can still
hold a shared reflection that has since been removed from main.

Connections use shared evidence file paths, then follow claims, bindings, and
sections. They identify related knowledge without deciding whether it agrees
with the finding. Orient includes unconnected discoveries with `relatedPages: []`.
Outline and read narrow to the requested page and returned sections, respectively.
Read includes evidence resource URIs; captured versions remain in the stored file.

If missing or shallow history leaves a readable finding's origin unknown, return
it in the optional fallback using the same tool-specific entry shape:

```json
{
  "unclassifiedReflections": {
    "unavailable": "Local Git history is shallow, so this reflection's main-versus-branch origin cannot be established. Fetch the required history and retry.",
    "reflections": [
      {
        "id": "reflection-550e8400-e29b-41d4-a716-446655440000",
        "finding": "The retry limit includes the initial attempt; configure three for two retries.",
        "relatedPages": ["concepts/jobs.md"]
      }
    ]
  }
}
```

This object accompanies the usual three layers and is omitted when all relevant
records are readable and classified. A record visible in main's snapshot can
still be classified in a shallow clone. Other known findings stay in their
layers, and source comparison failures do not prevent reflection classification.

Malformed or unreadable reflection files also produce a fallback explanation;
valid neighboring files remain available. The fallback array can be empty when
all readable findings were classified but some files could not be read. If wiki
metadata prevents connection lookup, readable findings are retained there with
empty relationships because their scope cannot be established.

Retrieval does not revalidate a finding against current source, rewrite its
record, or consolidate it. Evidence may have changed since capture. Treat
reflections as leads for investigation until they are consolidated into maintained
claims and prose.

An update [consolidates its captured pending findings](reflections.md#consolidation-through-the-existing-update-workflow)
through ordinary page reconciliation and deletes the processed files. Subsequent
retrieval returns accepted knowledge in `longTerm`; the consumed reflections no
longer appear in short-term or working arrays. Failed processing and later arrivals
remain available as pending findings.

## Correctable failures

Unknown section IDs return an MCP tool error directing the agent to
`openwiki_outline`. Missing pages direct it to `openwiki_orient` or wiki setup.
The transport remains available for corrected calls.

`outline` and `read` require complete section and binding metadata that matches
the page. A legacy page without those links must participate in an OpenWiki
update before section retrieval works. Inconsistent linkage likewise requires
page reconciliation. `orient` can still return its introduction and page directory
when sidecar problems make change connections unavailable. Retrieval never
invents IDs or repairs files. See
[page authoring](page-authoring.md) for maintaining these relationships.
