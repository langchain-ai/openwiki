# OpenWiki living memory plan

Status: all six phases are implemented and validated on the working branch.
The agent guidance, product documentation, and installed MCP workflow now cover
the complete memory lifecycle. Validation scope is recorded with each phase.

## Purpose and user story

OpenWiki brings coding intelligence to coding agents through living repository
memory. It helps agents start informed and leave the next agent better informed.
The promise is less repeated investigation, better starting context, and
discoveries that survive a session.

An agent working in an unfamiliar repository should be able to:

1. Find relevant repository knowledge without reading the entire wiki.
2. Retrieve explanations with supporting claims and code evidence.
3. Understand relevant changes since that knowledge was verified, including
   changes in its own checkout and pending reflections.
4. Verify assumptions against code and complete its task.
5. Leave useful discoveries for other agents.
6. Have those discoveries evaluated and consolidated into maintained knowledge.

The loop is: **consult memory → verify and work → record discoveries → consolidate**.

This workflow should lead the eventual product introduction and blog post. The
memory model and tools explain how it works. The promise is useful context with
visible freshness and uncertainty, rather than a guarantee that every wiki
statement is always current. Code and tests remain authoritative.

## Memory available during retrieval

- **Long-term memory:** consolidated wiki prose and durable claims grounded in
  code at known revisions.
- **Short-term memory:** changes on main that the wiki has not incorporated yet.
- **Working memory:** changes on the current branch and in the working tree.
- **Reflections:** explicit discoveries and corrections available locally,
  including reflections pulled from main, until they are consolidated.

Changes show what changed; reflections can explain what was learned. Reflections
can start as local working knowledge, become shared short-term knowledge when
merged, and become long-term knowledge through consolidation. Retrieval should
preserve their origin and provisional status.

## Phase 1: Establish durable, verifiable memory

Connect code evidence ↔ durable claims ↔ specific prose passages within wiki
sections. Record the code revision the knowledge was verified against, and
preserve claim identities across updates. Claim identity is distinct from
validity: evidence, wording, and validity can change while the claim retains its
identity.

**Accomplishes:** we can retrieve the evidence behind an explanation and identify
which knowledge and passages may need rechecking when code changes.

### Implementation status

Implemented: stable sections and prose bindings in the existing page sidecar,
shared native/MCP sparse submission schemas, on-demand metadata inspection,
affected bindings in page assignments, and validation before session mutation
and page completion. Existing evidence versions and per-page source checkpoints
continue to provide the source baseline.

Section locations use whitespace-free, case-preserving heading components with
`encodeURIComponent` escaping. New bindings reference existing IDs or exact new
section locations and claim statements; OpenWiki resolves them to durable IDs.
Legacy sidecars remain readable and gain metadata when their pages are actively
submitted. The [page authoring guide](docs/page-authoring.md) documents the
implemented contract, examples, and recovery behavior.

Validation: `pnpm test` passed typechecking, build, and coverage with 3,051 tests
passed and three skipped. Lint and formatting checks passed. Tests cover sparse
updates, stable identities, ambiguous and missing passages, persistence, legacy
state, and native/MCP correction and retry. The full test suite required execution
outside the sandbox for existing local-server and OpenWiki-home tests.

### Existing foundation and the missing connection

Claims remain the factual backbone. Each claim has a stable ID, a statement, and
versioned code evidence. Before phase 1, the page sidecar associated claims with
their owning page without identifying the passages expressing each claim.
Bindings now make that connection explicit. Semantic agreement still relies on
the authoring agent following the writing contract; prose is not mechanically
generated from individual claims.

Add explicit **bindings** to record where claims are expressed. A passage can
express multiple claims, and a claim can appear in multiple passages.

### Storage and binding format

Keep bindings in the existing page sidecar, in a separate `bindings` field
alongside `claims`. Section metadata lives in a `sections` field in the same
sidecar. Do not create a separate bindings file or nest bindings inside individual
claims.

For example:

```text
openwiki/transactions.md               Ordinary wiki Markdown
openwiki/.claims/transactions.json     Claims, evidence, bindings, and sections
```

Each section has a stable ID, a location, and an authored description. Each
binding has a stable ID, a section reference, the exact prose text, and supporting
claim IDs. The following illustrates the two sidecar fields:

```json
{
  "sections": [
    {
      "id": "section-3",
      "location": "transactions.md#Transactions#FailureHandling",
      "description": "Rollback ordering and retry limits."
    }
  ],
  "bindings": [
    {
      "id": "binding-7",
      "sectionId": "section-3",
      "text": "Retries are limited to three attempts.",
      "claimIds": ["claim-2"]
    }
  ]
}
```

- Each `id` identifies its section or binding across edits.
- A section's `location` is a single string identifying the wiki page followed
  by its nested heading path, from outermost heading to the target section. It
  is an OpenWiki locator, not a standard browser fragment or Markdown anchor.
- A binding's `sectionId` points to the section containing the passage. The
  location lives on the section, rather than being repeated on each binding.
- `text` identifies the exact passage within that section. The connection is to
  this passage, not merely to the section as a whole.
- `claimIds` identifies the claims expressed by that passage.

OpenWiki follows `sectionId` to the section's location, resolves the page and
heading path, then finds the exact text within that section. Missing or ambiguous
matches require correction rather than fuzzy matching or guessing. Heading
normalization, delimiter escaping, and other parsing details will be defined
during implementation.

This incorporates the phase 2 decision to give sections stable identities.
Renaming a heading updates the section's location once; its ID and the bindings
referencing it can remain unchanged.

Keep Markdown plain: no embedded claim links, hidden passage markers, or new
Markdown annotation format in phase 1. Retrieval tools use the sidecar to join
prose with its claims and evidence.

### Reconciliation lifecycle

Distinguish retrieval from maintenance. Future `read` calls return relevant
prose, claims, bindings, and freshness information; reading does not automatically
start a wiki rewrite. The coding agent can check the relevant code for its task
and later record a reflection through the reflection workflow.

During an OpenWiki update, preflight checks evidence across the wiki, and pages
with stale or unresolved claims are included in the update plan. Each page worker
receives that page's claims requiring attention. This existing page-scoped
handoff will include the affected claims' bindings.

The lifecycle is:

1. Detect changed or missing code evidence and flag the affected claim for review.
   Changed evidence does not automatically make the claim false.
2. Attach all bindings for that claim so the author can locate the relevant
   passages and read their surrounding context.
3. Review the current code and explicitly confirm, revise, or retract the claim.
4. Review every passage expressing that claim; keep, rewrite, or remove the prose
   as appropriate. One factual decision can require reviewing several passages.
5. Review whether affected sections' descriptions still fit, and submit the
   finished page with incremental claim, binding, and section metadata changes.
   Validate the resulting connections before marking the page complete.

For example, if the retry limit changes from three to five, revise `claim-2`,
refresh its evidence, rewrite the sentence, and update `binding-7` to contain the
new text. Both IDs remain stable. If only the sentence is reworded, update the
binding while retaining the unchanged claim. If the claim remains correct after
code review, confirm it and keep accurate prose and unchanged bindings.

The binding directs attention to prose; the authoring agent determines how its
meaning and surrounding explanation must change.

### Incremental submission and validation

Bindings use sparse reconciliation, like claims. The author does not resubmit a
complete binding list for every page update.

| Change                                                                     | Binding decision                                                           |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Add a passage                                                              | Add a binding with its section ID, text, and claim references.             |
| Rewrite a passage, move it to another section, or change supporting claims | Update the existing binding using its stable ID.                           |
| Rename or move a section                                                   | Update the section's location; retain binding references to its stable ID. |
| Remove a passage                                                           | Remove its binding.                                                        |
| Leave a passage and its connection unchanged                               | Omit the binding; OpenWiki retains it automatically.                       |

Claim behavior stays incremental as well: submit additions or revisions,
explicitly confirm flagged claims that remain correct, and retract removed
claims. Untouched, issue-free claims are retained automatically. A flagged claim
still requires review of its bound prose even if the resulting bindings do not
need to change.

Omitted bindings are retained, not exempted from validation. Validate every
resulting binding against the finished page and resulting claim set:

- Every referenced section exists, its page and location resolve, and the exact
  passage is found unambiguously within it.
- Every referenced claim exists; no binding references a retracted claim.
- Changed or removed prose has not left a retained binding pointing to missing
  text.

Validation failures are actionable feedback to the agent, not crashes. Identify
the affected binding, explain the failure, and indicate what needs correction.
For example:

```text
binding-7: passage not found in the specified section.
Correct the section location, binding section reference, or text as appropriate;
remove the binding if the passage was deleted.
```

Keep the page pending while the author corrects and resubmits it. Preserve
previously completed pages and allow the update to continue after correction.

Structural validation proves that references resolve. The authoring agent remains
responsible for checking that claims are supported by code and that prose
accurately expresses them; matching text alone does not prove factual agreement.

### Supported editing workflow and deferred hardening

Supported wiki edits go through OpenWiki's update and page-submission workflow,
which maintains prose, claims, bindings, and section metadata together. Editing
the Markdown as part of that workflow is expected; the subsequent submission
validates the connections.

Direct wiki edits outside that workflow are not recommended. Special detection,
retrieval behavior, and recovery for those edits are deferred to later hardening.
Phase 1 does not add a separate maintenance workflow for them.

## Phase 2: Add progressive retrieval

Build three MCP tools over the consolidated wiki:

- `orient`: provide a compressed repository overview and identify where to look.
- `outline`: provide a compressed view of a page and its sections.
- `read`: return selected sections with their relevant claims and code evidence.

Define clear, compact responses that let an agent move from repository context
to specific explanations. Each step should save investigation effort and provide
enough context to choose the next step.

**Accomplishes:** an unfamiliar agent can find the context it needs without
reading the whole wiki or discovering its structure manually.

### Implementation status

Implemented: independent `openwiki_orient`, `openwiki_outline`, and
`openwiki_read` MCP tools with strict inputs and the agreed `longTerm` responses.
Retrieval reuses the existing Markdown parser and claims store. It invokes no
model, starts no generation run, and writes no files. The
[retrieval guide](docs/retrieval.md) documents inputs, outputs, and recovery.

The quickstart overview is its opening section's direct prose, trimmed and ending
at the next heading. An unheaded introduction is supported. Page titles and
descriptions must be non-empty authored frontmatter strings. Shared worker and
host guidance explains their retrieval purpose and how to maintain the summary.

`outline` and `read` require complete section and binding metadata that matches
the Markdown. Legacy pages must participate in an update to establish links;
missing or inconsistent metadata produces correction guidance. `orient`'s
`longTerm` payload reads frontmatter and introductory prose without sidecars;
phase 3's change connections use the persisted claims and bindings.

Validation: `pnpm test` passed typechecking, build, and coverage with 3,066 tests
passed and three skipped. Full lint and formatting checks passed. Tests exercise
document order, nested and overlapping selectors, stable IDs after renames,
claim filtering, legacy state, and recoverable errors over MCP. The compiled
orientation tool also read this repository's existing 21-page wiki successfully.

### Shared retrieval contract

The three tools are independent, not a mandatory sequence. An agent that already
knows a page or section can call `read` directly. Page paths are relative to the
wiki directory and pass unchanged between tools. Section IDs returned by
`outline` are accepted by `read`.

Retrieval is deterministic over maintained wiki content and metadata, with no
model invocation at read time. The output examples in this phase show the
consolidated content returned inside `longTerm`. Phase 3 defines the full response
shape with `longTerm`, `shortTerm`, and `working` at the top level. Tool inputs
remain unchanged. Phase 4 describes how reflection retrieval extends these shapes.

### Orient: fixed overview and page directory

Input:

```json
{
  "root": "/path/to/repository"
}
```

Long-term payload (`longTerm` in the full response):

```json
{
  "overview": "Acme is a background job service. API requests enqueue jobs, workers execute them, and PostgreSQL stores job state.",
  "pages": [
    {
      "page": "architecture/overview.md",
      "title": "Architecture",
      "description": "Service boundaries, request flow, and how the API, queue, workers, and database interact."
    },
    {
      "page": "concepts/job-lifecycle.md",
      "title": "Job lifecycle",
      "description": "Job states and transitions, retry limits, cancellation behavior, and recovery of interrupted jobs."
    },
    {
      "page": "workflows/local-development.md",
      "title": "Local development",
      "description": "Running the service locally, configuring dependencies, and executing tests."
    }
  ]
}
```

`orient` is a fixed, compact overview of the whole wiki. It accepts no task or
query and performs no relevance ranking or task-based page selection.

Source `overview` from the designated opening summary in `quickstart.md`. During
generation and updates, the author maintains a short, standalone explanation of
what the repository does, its major parts, and how they fit together. It describes
the repository, rather than describing the quickstart document's purpose. The
tool extracts this introduction; it does not maintain another copy of the summary.

Source page titles and descriptions directly from OKF frontmatter. Authoring
guidance must treat these fields as navigation for a future agent:

- A title clearly identifies the page's subject.
- A description explains its scope and the questions it answers, distinguishing
  it from neighboring pages.
- Updates keep both aligned with the page's actual scope.

For example, "Job states and transitions, retry limits, cancellation behavior,
and recovery of interrupted jobs" helps selection more than "Documentation about
the job lifecycle."

### Outline: section hierarchy with authored descriptions

Input:

```json
{
  "root": "/path/to/repository",
  "page": "concepts/job-lifecycle.md"
}
```

Long-term payload (`longTerm` in the full response):

```json
{
  "page": "concepts/job-lifecycle.md",
  "title": "Job lifecycle",
  "description": "Job states and transitions, retry limits, cancellation behavior, and recovery of interrupted jobs.",
  "sections": [
    {
      "id": "section-1",
      "location": "concepts/job-lifecycle.md#JobLifecycle#States",
      "title": "States",
      "description": "Valid job states and the transitions between them."
    },
    {
      "id": "section-2",
      "location": "concepts/job-lifecycle.md#JobLifecycle#FailureHandling",
      "title": "Failure handling",
      "description": "What happens when execution fails or a worker disappears."
    },
    {
      "id": "section-3",
      "location": "concepts/job-lifecycle.md#JobLifecycle#FailureHandling#Retries",
      "title": "Retries",
      "description": "Which failures trigger retries, attempt limits, and backoff behavior."
    }
  ]
}
```

Return sections as a flat list in document order. Locations express the nested
heading hierarchy; stable IDs are the selectors for `read`. Extract headings
and their structure from Markdown, and combine them with section IDs, locations,
and authored descriptions in the sidecar's `sections` field.

Section descriptions are authored during generation and maintained during
updates. They explain scope to help an agent choose what to read. This is an
intentional authoring responsibility, handled within page reconciliation rather
than by generating summaries during retrieval.

### Read: selected prose, bindings, and supporting claims

Input:

```json
{
  "root": "/path/to/repository",
  "page": "concepts/job-lifecycle.md",
  "sections": ["section-3"]
}
```

Long-term payload (`longTerm` in the full response):

```json
{
  "page": "concepts/job-lifecycle.md",
  "sections": [
    {
      "id": "section-3",
      "location": "concepts/job-lifecycle.md#JobLifecycle#FailureHandling#Retries",
      "content": "### Retries\n\nFailed jobs are attempted at most three times."
    }
  ],
  "bindings": [
    {
      "id": "binding-7",
      "sectionId": "section-3",
      "text": "Failed jobs are attempted at most three times.",
      "claimIds": ["claim-2"]
    }
  ],
  "claims": [
    {
      "id": "claim-2",
      "statement": "A failed job receives at most three total execution attempts.",
      "evidence": [
        {
          "resource": "repo://src/worker/retry.ts#L12-L20"
        }
      ]
    }
  ]
}
```

- Omitting `sections` reads the whole page.
- Selecting a parent section includes its nested sections. Return them as
  separate entries in document order, each containing its own heading and direct
  Markdown content. Overlapping selections do not duplicate prose.
- Return bindings for the selected sections and their included descendants.
- Return only referenced claims, each once even when several bindings reference
  it, with code evidence resources. Evidence versions remain maintained in the
  underlying claim records.
- Unknown section IDs produce actionable feedback directing the agent to
  `outline`, rather than silently returning incomplete content.

### One page reconciliation workflow

Maintain claims, bindings, and section descriptions through the same author and
page submission. They have distinct responsibilities and stable identities:

| Piece   | Responsibility                                        | Identity   |
| ------- | ----------------------------------------------------- | ---------- |
| Claim   | What we believe, supported by code evidence           | Claim ID   |
| Binding | Where a claim is expressed in prose                   | Binding ID |
| Section | Location and scope description for a Markdown section | Section ID |

The connected structure is:

```text
Code evidence ↔ Claim ↔ Binding ↔ Section
                          │          │
                      Prose text  Description
```

Markdown remains authoritative for section structure and prose. Descriptions
annotate sections; bindings connect their passages to claims. Section IDs remain
stable when headings or descriptions change, just as claim and binding IDs
remain stable across revisions.

Apply the same incremental rule to all three: submit additions, updates, and
removals; retain untouched entries; validate the resulting page. The author gets
the page, relevant claim issues and bindings, and existing section descriptions,
then submits the necessary changes together. Section changes are keyed by stable
ID, not by a location that can change during a rename.

Changes flag connected material for appropriate review, without making every
record stale or requiring every record to change:

| Trigger                       | Review or update                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Code evidence changes         | Review the claim, all its bound passages, and whether affected section descriptions still fit.                 |
| Prose changes                 | Review its binding, agreement with linked claims, and whether the section description still fits.              |
| A heading is renamed or moved | Update the section location and validate its bindings; this alone does not require re-verifying code evidence. |
| A description is reworded     | Check it against the section; linked claims do not automatically become stale.                                 |

For example, changing a retry limit from three to five normally changes the claim,
prose, and binding, while "Retry limits and backoff behavior" can remain the
section description. Adding cancellation behavior may also change the section's
scope and description.

Validate the resulting section locations, binding section references, exact
passages, and claim references together. Return actionable issues in one response
and keep the page pending for correction, preserving completed work. The author
is responsible for semantic accuracy: structurally valid metadata does not prove
that evidence supports a claim or that a section description still fits.

## Phase 3: Make retrieval aware of changes

Account for changes on main since the wiki's verified revision, changes on the
current branch, and uncommitted working changes. Surface relevant changes
alongside affected knowledge at the appropriate level in each retrieval tool.

Keep the agent's actual checkout explicit: a change on main may not yet exist on
its branch. Changed evidence marks a claim as needing attention, rather than
automatically declaring it false. Preserve the distinction between verified
knowledge and detected changes, including gaps in evidence coverage.

**Accomplishes:** retrieval explains established knowledge in the context of
current work, with freshness and uncertainty visible.

### Implementation status

Implemented: all three MCP retrieval tools return `longTerm`, `shortTerm`, and
`working` with the agreed scope-specific relationships and changed source
resources linked to claims in `read`.
Inputs and consolidated prose stay unchanged. Comparisons are read-only and use
existing per-page checkpoints, with the whole-wiki checkpoint as the legacy
fallback; no new persistent state or comparison index is introduced.

Main comparisons begin at the shared ancestor of the page checkpoint and the
locally known default branch. Working comparisons begin at the checkout's shared
ancestor with that branch and include the final combined effect of branch
commits, staged edits, unstaged edits, and untracked files. Upstream changes absent
from an older branch are not treated as local removals. Page-specific coverage
is respected after partial updates, while `orient` retains uncovered resources.

Default-branch discovery uses origin's symbolic default when present, otherwise
`main` or `master`. Comparable local and origin-tracking tips use the descendant;
divergent tips produce an unavailable comparison. Retrieval never fetches.
`inCheckout` tests whether every contributing main commit is reachable from
checkout history; partial incorporation is false, and equivalent cherry-picked
patches are not inferred from matching content.

Evidence connections are conservative at the file level: even a change outside
a cited line range can identify that file's claims for review. Renames are
represented as deletion and addition. Generated wiki output and ignored source
paths are excluded. Missing history, unreadable comparison inputs, and unresolved
working conflicts produce explicit `unavailable` layers while independently
checkable layers and readable wiki content remain available. The
[retrieval guide](docs/retrieval.md) records the complete behavior and limits.

Validation: `pnpm test` passed typechecking, build, and coverage with 3,089 tests
passed and three skipped. Full lint and formatting checks passed. Tests cover
the three-to-five-to-seven example, branches behind main, partial incorporation,
partial page updates, combined local work, renamed/binary/untracked resources,
ignore rules, missing and shallow history, and independent failure handling.
The compiled `orient` tool also returned all three layers for this repository's
21-page wiki and current working branch.

### Output design principle

Every returned field needs a concrete purpose for the agent now. Omit fields
whose only justification is possible future use; add them later when needed.

Use three explicit top-level layers in every retrieval response:

- `longTerm`: the consolidated wiki knowledge relevant to the tool's scope.
- `shortTerm`: changes on main that the wiki has not incorporated.
- `working`: the resulting branch and local working-tree changes.

Do not put only the changes under a generic `memory` wrapper while leaving wiki
knowledge outside it. The same three layers make established knowledge and its
qualifying changes explicit throughout retrieval.

The level of detail follows the question the tool answers:

| Tool      | Agent's question                                                       | Change connections                                                                         |
| --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `orient`  | Where should I look?                                                   | Repository-wide changes linked to affected pages.                                          |
| `outline` | Which sections should I read?                                          | Changes connected to the requested page, linked to affected sections.                      |
| `read`    | What does the wiki say, what supports it, and what needs verification? | Changed source resources connected to the selected sections and linked to affected claims. |

### Orient response

```json
{
  "longTerm": {
    "overview": "Acme runs background jobs through a queue and worker pool.",
    "pages": [
      {
        "page": "concepts/job-lifecycle.md",
        "title": "Job lifecycle",
        "description": "Job states, retries, cancellation, and recovery."
      }
    ]
  },
  "shortTerm": {
    "changes": [
      {
        "resource": "repo://src/worker/retry.ts",
        "inCheckout": true,
        "affectedPages": ["concepts/job-lifecycle.md"]
      }
    ]
  },
  "working": {
    "changes": [
      {
        "resource": "repo://src/worker/retry.ts",
        "affectedPages": ["concepts/job-lifecycle.md"]
      }
    ]
  }
}
```

`orient` remains fixed, with no task query or ranking. Include changed resources
even when no wiki connection is known, with an empty `affectedPages` array. This
exposes new or otherwise uncovered code rather than hiding it because it has no
claims yet. An empty relationship list means no known connection, not proof that
the change has no implications for the wiki.

### Outline response

```json
{
  "longTerm": {
    "page": "concepts/job-lifecycle.md",
    "title": "Job lifecycle",
    "description": "Job states, retries, cancellation, and recovery.",
    "sections": [
      {
        "id": "section-3",
        "location": "concepts/job-lifecycle.md#JobLifecycle#Retries",
        "title": "Retries",
        "description": "Retry eligibility, attempt limits, and backoff."
      }
    ]
  },
  "shortTerm": {
    "changes": [
      {
        "resource": "repo://src/worker/retry.ts",
        "inCheckout": true,
        "affectedSectionIds": ["section-3"]
      }
    ]
  },
  "working": {
    "changes": [
      {
        "resource": "repo://src/worker/retry.ts",
        "affectedSectionIds": ["section-3"]
      }
    ]
  }
}
```

Include changes connected to this page. Follow changed evidence through claims
and bindings to identify the affected sections. Locations retain the heading
hierarchy, while IDs let the agent select those sections in `read`.

### Read response

This example follows one change through all three layers: the wiki records three
attempts, an incorporated main change raises the limit to five, and local work
raises it to seven.

```json
{
  "longTerm": {
    "page": "concepts/job-lifecycle.md",
    "sections": [
      {
        "id": "section-3",
        "location": "concepts/job-lifecycle.md#JobLifecycle#Retries",
        "content": "## Retries\n\nFailed jobs are attempted at most three times."
      }
    ],
    "bindings": [
      {
        "id": "binding-7",
        "sectionId": "section-3",
        "text": "Failed jobs are attempted at most three times.",
        "claimIds": ["claim-2"]
      }
    ],
    "claims": [
      {
        "id": "claim-2",
        "statement": "A job receives at most three total execution attempts.",
        "evidence": [
          {
            "resource": "repo://src/worker/retry.ts#L12-L20"
          }
        ]
      }
    ]
  },
  "shortTerm": {
    "changes": [
      {
        "resource": "repo://src/worker/retry.ts",
        "inCheckout": true,
        "affectedClaimIds": ["claim-2"]
      }
    ]
  },
  "working": {
    "changes": [
      {
        "resource": "repo://src/worker/retry.ts",
        "affectedClaimIds": ["claim-2"]
      }
    ]
  }
}
```

Change entries identify source resources whose connected claims need verification.
Agents inspect the relevant source version or use native Git tools for details.
Keep the consolidated prose as written and attach the change references; do not
silently rewrite it into a newly asserted explanation. Inline diffs are deferred
until they can be targeted usefully to the requested knowledge. Retrieval does
not add response budgets or pagination for this change.

Only changes connected to the selected sections and included descendants belong
in this response. Claims are returned once, and existing bindings connect affected
claim IDs back to exact passages. The `read` response omits a separate page title:
the page path and returned headings already identify the content.

### Why each field exists

| Field                                                                     | Purpose for the agent                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `longTerm`, `shortTerm`, `working`                                        | Distinguish consolidated knowledge, subsequent main changes, and current local work.           |
| `overview`                                                                | Establish the repository's purpose and major parts.                                            |
| `page`                                                                    | Identify the wiki document and provide a reusable tool input.                                  |
| Page `title` and `description` in `orient` and `outline`                  | Choose a page and understand its scope.                                                        |
| Section `id`                                                              | Select or reference a specific section consistently.                                           |
| Section `location`                                                        | Show its heading hierarchy and locate it in Markdown.                                          |
| Section `title` and `description` in `outline`                            | Decide which sections to read.                                                                 |
| Section `content` in `read`                                               | Supply the actual explanation.                                                                 |
| `bindings`, including IDs, section references, text, and claim references | Connect specific passages to the claims they express and identify those connections.           |
| `claims`, including IDs, statements, and evidence resources               | State the supporting propositions and locate the code that supports them.                      |
| `changes`                                                                 | Enumerate detected changes within this tool's scope.                                           |
| Change `resource`                                                         | Identify the changed code to inspect.                                                          |
| `inCheckout`                                                              | Distinguish incorporated main changes from changes that exist only upstream.                   |
| `affectedPages`, `affectedSectionIds`, or `affectedClaimIds`              | Connect changes to the level of knowledge the agent is navigating or reading.                  |
| `unavailable`                                                             | Explain when a memory layer could not be checked, rather than implying that it has no changes. |

### Meaning of inCheckout

Keep the field name `inCheckout`. It applies to a short-term change and answers:
has this change on main been incorporated into the branch the agent is working
on?

- If main changes the retry limit from three to five but the branch has not
  incorporated that change, `inCheckout` is `false`. The upstream change is not
  presented as the behavior of the agent's current code.
- After the branch incorporates the change, `inCheckout` is `true`.
- If local work subsequently changes five to seven, `inCheckout` remains `true`
  for the incorporated main change, and the additional edit appears in `working`.

This is about incorporation into checkout history, not an assertion that current
file contents exactly match main. Working changes may modify the behavior again.
A claim can still match local code while short-term memory reports an incoming
change upstream. An affected-claim connection means review its evidence, not
that the claim is necessarily false.

### Unavailable comparisons and deliberately omitted fields

A successfully checked layer with no changes in the tool's scope returns
`{"changes": []}`. If comparison cannot be performed, return an explanation
instead of a changes list:

```json
{
  "shortTerm": {
    "unavailable": "The wiki checkpoint is missing from local Git history."
  }
}
```

The same convention applies to working memory. The other layers remain available
when their own inputs can be evaluated. With the phase 4 extension, failure to
compare Git history must not hide readable reflection files. Phase 4 documents
the independent reflection arrays and exceptional unclassified fallback.

Do not include these fields in the normal response:

- Revision hashes or comparison baselines: necessary internally to compute the
  changes correctly, but not needed for the agent's immediate navigation or
  understanding in this interface.
- Generic `status` or comparison metadata: use the explicit `unavailable` case
  when the layer cannot be checked.
- Labels distinguishing branch commits, staged edits, unstaged edits, and
  untracked files: working memory presents the resulting local changes, without
  exposing Git staging details. Those sources of local work still need to be
  accounted for internally.
- Inline diffs: file-level patches can overwhelm a focused read. Return changed
  resources and affected claim IDs so agents can inspect the details they need.
- Model-generated change summaries: change detection does not require a model
  invocation or an unverified semantic interpretation at retrieval time.

Compute comparisons with awareness of the wiki checkpoint, main, branch history,
and the actual working tree. Do not mistake upstream commits missing from a
branch for local removals, or treat every upstream change as present locally.
The comparison implementation must support these semantics; its internal Git
bookkeeping does not become part of the normal retrieval output.

## Phase 4: Capture and retrieve reflections

Add a `reflect` MCP tool and a repository-local format for discoveries,
corrections, and supporting evidence. Reflections can travel with a PR. Include
relevant local and pulled reflections in retrieval immediately, clearly
identified as provisional.

**Accomplishes:** discoveries survive a session and become useful to other
agents before the next wiki update.

### Implementation status

Implemented: `openwiki_reflect` captures canonical versioned repository evidence
and atomically publishes one UUID-named file, independently of generation runs.
Orient, outline, and read include locally present reflections in their existing
short-term and working layers, with connections derived from shared evidence
files through claims and bindings. Unknown origin and inventory gaps have an
explicit fallback that preserves readable findings without guessing.

The [reflection guide](docs/reflections.md) covers capture, storage, sharing, and
retry behavior; the [retrieval guide](docs/retrieval.md) includes all response
shapes and partial availability. Bundled skill and MCP guidance advertise the
workflow. Phase 5 below extends this capture and retrieval foundation with consolidation.

Validation: `pnpm test` passed typechecking, build, and coverage with 3,111 tests
passed and three skipped. Lint and formatting checks passed. Tests cover evidence
validation, concurrent creation, collision preservation, partial inventory,
main/branch classification, pulled and historical records, shallow history,
scoped retrieval, and rejected MCP calls followed by successful capture and read.
The full suite required execution outside the sandbox for its existing
local-server and OpenWiki-home tests.

### Definition and authoring standard

**A reflection is a repository-specific discovery from doing a task that would
help a future agent, but is not yet captured accurately in the wiki.**

It records what was learned, when it applies, and evidence another agent can
check. It is a candidate for durable knowledge, not automatically an established
fact. The practical test is: would knowing this have saved the next agent
meaningful investigation or prevented a mistake? If so, and the finding is
supported by evidence and missing or incorrect in the wiki, it belongs in a
reflection.

Useful reflections include:

- An undocumented constraint discovered while implementing a feature.
- A verified explanation for a failure encountered during debugging.
- An exception that makes an existing wiki claim incomplete.
- A relationship between components that took investigation to establish.

For example, "I changed the retry limit" is a task summary. "The retry limit
includes the initial attempt, so a limit of three permits at most two retries"
is reusable knowledge. The attempt counter and its boundary test could support
that discovery.

### API surface and output

Start with one creation tool, `reflect`, and retrieve reflections through the
existing `orient`, `outline`, and `read` tools.

Input:

```json
{
  "root": "/path/to/repository",
  "finding": "The retry limit counts the initial attempt. A limit of three means one initial attempt and at most two retries.",
  "evidence": [
    {
      "resource": "repo://src/worker/retry.ts#L12-L20"
    }
  ]
}
```

- `root` identifies the repository.
- `finding` records the discovery and any conditions needed to understand it.
- `evidence` provides canonical repository resources that another agent and the
  consolidation process can use to verify the finding.

Output:

```json
{
  "id": "reflection-<uuid>",
  "path": "openwiki/.reflections/reflection-<uuid>.json"
}
```

The ID identifies the finding in retrieval and consolidation. The path identifies
the artifact to include with the task's changes. Do not echo the submitted
finding in the creation response. Empty findings or invalid evidence return
actionable feedback.

### Stored format and location

Store one reflection per JSON file in the repository:

```text
openwiki/.reflections/
  reflection-<uuid-a>.json
  reflection-<uuid-b>.json
```

These files are intended to be tracked and travel with a PR. They are pending
knowledge, separate from consolidated claims, and must be treated as such during
updates.

Each file contains:

```json
{
  "id": "reflection-<uuid>",
  "finding": "The retry limit counts the initial attempt. A limit of three means one initial attempt and at most two retries.",
  "evidence": [
    {
      "resource": "repo://src/worker/retry.ts#L12-L20",
      "version": "<captured evidence version>"
    }
  ]
}
```

OpenWiki captures evidence versions rather than asking the author to supply
them. As with claims, those versions let consolidation detect source changes
since the discovery was recorded. Capturing an evidence version does not certify
the finding's truth.

Do not initially add authors, timestamps, tags, importance scores, or lifecycle
status. File presence means the reflection is pending; consolidation eventually
removes it. Conditions and qualifications belong in the finding itself.

### Incorporation into retrieval

Add `reflections` alongside `changes` in the existing short-term and working
memory layers. The following is the memory-layer extension; each tool retains
its existing `longTerm` content:

```json
{
  "shortTerm": {
    "changes": [],
    "reflections": []
  },
  "working": {
    "changes": [],
    "reflections": []
  }
}
```

- Locally available reflections already merged into main belong in `shortTerm`.
- New local or branch reflections belong in `working`.
- Include reflections pulled from main as well as those created locally, and
  return each reflection once within a response.
- Reflections remain provisional. They become long-term knowledge only through
  consolidation into claims and prose, not merely by merging the files into main.

Reflection entries follow the tool's scope:

| Tool      | Fields on each reflection entry                | Purpose                                                                               |
| --------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `orient`  | `id`, `finding`, `relatedPages`                | Discover pending knowledge and where it connects to the wiki.                         |
| `outline` | `id`, `finding`, `relatedSectionIds`           | See discoveries relevant to the requested page and choose sections.                   |
| `read`    | `id`, `finding`, `evidence`, `relatedClaimIds` | Read the discovery, verify it, and understand its relationship to existing knowledge. |

For example, a reflection entry in `read` would be:

```json
{
  "id": "reflection-<uuid>",
  "finding": "The retry limit counts the initial attempt. A limit of three means one initial attempt and at most two retries.",
  "evidence": [
    {
      "resource": "repo://src/worker/retry.ts#L12-L20"
    }
  ],
  "relatedClaimIds": ["claim-2"]
}
```

Expose evidence resources for verification; captured evidence versions stay in
the stored reflection. Relationships are **related**, not automatic assertions
that the reflection supports or contradicts an existing claim.

Initially derive relationships from shared evidence resources, then follow
claims → bindings → sections → pages. Compute these connections during retrieval;
do not persist another relationship set to reconcile. Reflections with no known
wiki connection still appear in `orient`, with an empty `relatedPages` list, so
entirely new knowledge remains discoverable. `outline` and `read` narrow to
reflections connected to their requested content.

Missing Git history must not hide readable local reflection files. Preserve their
availability even when their main-versus-branch classification cannot be
established, using the explicit fallback described below.

### Concurrent creation and collisions

OpenWiki generates UUID-based IDs and filenames. Different branches create
different files, so ordinary concurrent additions can merge without contending
for the same filename. Do not introduce a shared index or append-only log that
would become a merge hotspot. New discoveries create new files rather than
editing another reflection.

UUID filenames address file collisions, not semantic duplication. Two agents may
record the same discovery under different IDs; consolidation evaluates and
deduplicates those findings.

### Retry and partial-availability behavior

Each creation call publishes a new UUID file. Retrying after an uncertain
response can create duplicates; consolidation-time deduplication is sufficient
initially. Do not add retry keys, a creation ledger, or another index. Publication
is atomic and refuses to replace an existing filename.

Source changes and reflections are evaluated independently. A layer can contain
`unavailable` for its source comparison and still contain classified `reflections`.
Missing wiki checkpoints do not prevent reflection retrieval.

If a finding cannot be classified, add an optional top-level object:

```json
{
  "unclassifiedReflections": {
    "unavailable": "The reason origin or inventory completeness could not be established.",
    "reflections": []
  }
}
```

The array contains readable findings whose origin or wiki scope could not be
established, using the same reflection shape as the tool's normal layers. Do not
guess their origin or repeat them in another layer. Known findings remain in
`shortTerm` or `working`. Malformed files produce an inventory-gap explanation
without hiding valid neighbors; the fallback array can therefore be empty.
Omit the object when the relevant inventory and classifications are complete.

Classify the exact immutable local record using the locally known default
branch's current and historical snapshots. A pulled file is short-term even if
the checkout has not merged its commit. A record removed from main can remain
short-term in an older checkout. Main-only files absent locally are not retrieved.
In shallow history, a matching snapshot proves short-term origin; absence alone
does not prove a finding originated locally.

Derive relevance conservatively from shared evidence **file paths**, reusing the
source-change connection logic. Captured ranges remain available in read evidence
but do not restrict these relevance connections. No relationship index is stored.

## Phase 5: Consolidate reflections into durable memory

Extend the update process to evaluate reflections against current code,
deduplicate them, reconcile contradictions, and update or create durable claims
and prose. Every update consolidates every reflection present when it starts.
Delete each reflection after successful processing, without introducing a separate
record of its outcome.

**Accomplishes:** useful discoveries become maintained knowledge, while
short-term memory stays bounded instead of accumulating indefinitely.

### Implementation status

Implemented through the existing native and MCP update lifecycle. Pending
reflections prevent a no-op at both CLI startup and generation begin. The planner
accounts for every captured finding; the assigned page author verifies and
consolidates it alongside ordinary claims, bindings, and sections. Validation
precedes page-state mutation, and deletion follows the page's durability proof.
No separate consolidation tool or persistent outcome registry was added.

The [reflection guide](docs/reflections.md) documents the complete contract and
recovery behavior. Native and MCP authors share planning/submission schemas and
consolidation guidance; the bundled skill and README describe the workflow.

Validation: `pnpm test` passed typechecking, build, and coverage with 3,129 tests
passed and three skipped. Lint and formatting checks passed. Tests cover clean
no-op overrides, exhaustive planning, new and revised claims, duplicate and
discarded findings, unchanged prose, evidence feedback, rejected submissions,
failed persistence, partial deletion, skipped pages, source-drift replanning,
later arrivals, and MCP retrieval after consolidation. Checkpoint failure tests
prove deletion follows plan/page durability and precedes page completion.
The full suite required execution outside the sandbox for its existing
local-server and OpenWiki-home tests.

### Implemented API and resume contract

- `begin` returns pending captured `reflections` with `id`, `finding`, and
  `evidence`. Each evidence entry has `resource` and an optional `issue` of
  `changed` or `unresolved`; captured versions remain internal. Evidence feedback
  guides verification and does not decide whether a finding is true.
- `submit_plan` assigns useful or already-represented findings to one page's
  `reflectionIds`, grouping duplicates with a canonical owning page. It accepts
  `discardedReflectionIds` for findings verified as unsupported, obsolete, or
  incorrect during planning. Every still-pending captured ID requires exactly
  one decision. A plan containing only discards may use `pages: []`.
- `next_page` remains a read of the queue and includes the job's pending
  `reflections` with current evidence feedback.
- `submit_page` accepts temporary `reflectionResults: [{ id, claims }]` alongside
  ordinary sparse reconciliation. Incorporated or duplicate knowledge references
  resulting claim IDs or exact new statements bound to the finished prose.
  `claims: []` discards a finding after verification. Every pending assigned
  finding needs a result; multiple findings may resolve to the same claim.
- `finish` refuses completion while any captured reflection remains pending,
  including findings on skipped pages. The run remains resumable; begin resets
  skipped jobs for retry. Later arrivals do not block the current update.

The existing run checkpoint retains `initialReflectionIds` as the starting input
scope and `reflectionIds` as ordinary page assignments. It stores no outcomes or
reflection-to-claim mappings. Captured IDs not assigned to pages were explicitly
discarded when the complete plan was validated, so cleanup can be retried from
that plan without a separate discarded-outcome list. Files remain the pending
work, and the normal checkpoint disappears on successful finish.

Planner discards are deleted after the plan is durable. Assigned findings are
deleted after page persistence and its durability proof, before the page manifest
and queue record completion. If cleanup partly fails, the saved page remains
available and only undeleted records require outcomes on retry. A resumed run
keeps its original scope; source drift replans only captured findings still on
disk. Legacy runs without a captured scope leave reflections for the next new
update.

### Processing scope and outcomes

At update start, collect the pending reflection files. Every reflection in that
starting set must be evaluated, even if its relevant page would not otherwise
need updating. Reflections created during the update can wait for the next one.

Check each finding against current code and existing wiki knowledge. The
reflection is a lead to investigate, not an instruction to accept. A change to
its recorded evidence calls for verification rather than automatic rejection.

Each reflection has one of three outcomes:

| Outcome                             | Action                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Useful knowledge                    | Incorporate it by adding or revising the relevant claims and prose through the existing page reconciliation workflow. |
| Already represented                 | Recognize the duplicate and avoid adding redundant knowledge.                                                         |
| Unsupported, obsolete, or incorrect | Discard it after checking the evidence.                                                                               |

Incorporation may also require changes to bindings and section metadata. Handle
all of these through the same page author and submission used for normal updates;
do not create a separate reflection reconciliation system.

For example, a reflection explains that the retry limit includes the initial
attempt, while the wiki incorrectly says "three retries." Verify the counter
and tests, correct the claim and explanation, update the binding, and persist
the resulting page state before deleting the reflection.

### Deletion and recovery

Delete a reflection only after its processing succeeds:

- For incorporated knowledge, the resulting page, claims, bindings, and section
  metadata must be saved successfully first.
- For a verified duplicate or discarded finding, no new wiki content is required
  before deletion.
- Failed processing or a failed/skipped page on which incorporation depends
  leaves the reflection pending for a later attempt.

If the wiki was saved but reflection deletion failed, the next update can
recognize that the knowledge is already represented and remove the duplicate.
Consolidation is complete only after all reflections in the starting set have
been successfully processed and removed. New arrivals remain for the next update.

### No additional tracking machinery

The pending reflection files themselves are the remaining work. Do not introduce
additional tracking files, persistent reflection-to-claim mappings, processing
logs, or reflection archives. Do not add a new persisted outcome registry to run
state for this purpose.

Resulting claims retain the useful knowledge and supporting evidence. Once a
reflection has been incorporated, recognized as a duplicate, or discarded, its
file can disappear; there is no need to retain which reflection produced which
claim.

## Phase 6: Complete onboarding and prove the workflow

Generate a small, self-contained OpenWiki guidance block in each applicable
`AGENTS.md` and `CLAUDE.md`. Name `orient`, `outline`, `read`, and `reflect`, and
explain when each helps. Keep argument schemas and detailed usage in the MCP
tool definitions.

When managing both instruction files, put the guidance directly in both rather
than linking one to the other. Remove only OpenWiki-owned cross-file pointers;
preserve user-written instructions and links. Avoid duplicating repository
summaries or mandatory wiki reading lists. Provide a lightweight file-based wiki
entry point when MCP is unavailable.

Exercise the complete user story with representative repository tasks, including
stale claims, branch changes, and reflections that are later consolidated. Use
that demonstrated workflow to shape the product introduction and blog narrative.

**Accomplishes:** agents know when to use OpenWiki, and we have concrete evidence
for the product promise.

### Implementation status

Implemented: repository setup generates the same self-contained guidance in
`AGENTS.md` and `CLAUDE.md`, naming `openwiki_orient`, `openwiki_outline`,
`openwiki_read`, and `openwiki_reflect`. Managed blocks explain optional use,
source verification, provisional discoveries, PR sharing, consolidation, and the
quickstart fallback. The OpenWiki-owned cross-file pointer is removed; user
content outside the markers, including links and whitespace, is preserved.
Both files in this repository were refreshed through the same setup function.

The README leads with the coding-agent user story, and the bundled integration
skill explains when retrieval and reflection help. The
[agent workflow](docs/agent-workflow.md) provides setup instructions, concrete
tool calls and response excerpts, the three-to-five-to-seven attempt example,
and the path from a discovery to shared and then maintained knowledge.

The workflow test installs a project integration into a temporary repository and
launches its configured command against the compiled CLI. Two independent MCP
clients verify advertised tools, progressive and direct retrieval, connections
to pages/sections/claims, main changes before and after incorporation, subsequent
working edits, reflection sharing without duplication, and consolidation.
Useful and duplicate findings resolve to one retained claim; an unsupported
finding is discarded. Correction after a rejected submission preserves pending
discoveries and previously completed page content. A later discovery remains
for the next update.

Validation: `pnpm test` passed typechecking, build, and coverage with 3,132 tests
passed and three skipped. Lint, formatting, and diff checks passed. Managed-block
tests cover independent guidance, ownership, whitespace preservation,
idempotence, and malformed-marker rejection. The full suite required execution
outside the sandbox for existing local-server and OpenWiki-home tests.

Validation scope: the integration uses real MCP processes and Git branches;
local merges model the PR handoff. Authoring and evaluation decisions are
scripted. No remote PR or live host-model session was used, and no research
quality, time, or token savings are claimed. The walkthrough proves the memory
lifecycle and provides a concrete starting point for a later blog demonstration.

### Agent entry points

The managed instruction blocks establish when to consult and contribute memory.
Keep the same small, self-contained guidance in each applicable instruction file;
agents should not need to follow a link from one instruction file to another to
discover the tools. Preserve unrelated user instructions and links.

The block should communicate the following, using the actual exposed MCP tool
names when implemented:

> OpenWiki provides repository memory through MCP tools. Consult it when
> repository context would help your task.
>
> - `orient`: understand the repository and find relevant wiki pages.
> - `outline`: inspect a page's sections and choose what to read.
> - `read`: retrieve selected explanations, supporting claims, relevant code
>   changes, and pending reflections.
> - `reflect`: record an evidence-backed discovery that would help a future agent
>   and is missing or incorrect in the wiki.
>
> Use these tools as needed; they are not a mandatory sequence. Check relevant
> code before relying on claims, and treat reflections as provisional. Leave
> useful discoveries with your task's changes for inclusion in its PR. OpenWiki
> updates consolidate pending reflections into maintained knowledge.
>
> If MCP is unavailable, start with `openwiki/quickstart.md` and inspect source
> directly. Maintain wiki prose and metadata through OpenWiki's update workflow.

Do not require retrieval for every trivial task or a reflection after every task.
Tool definitions own argument schemas, detailed selection behavior, and error
guidance. The instruction blocks explain purpose and usage without duplicating
that reference material or embedding a repository summary.

### Product explanation and examples

Update the README and relevant usage documentation around the complete user
story, with concrete examples for all four tools. Show how to make the tools
available through the supported integration setup, then demonstrate the outputs
and actions an agent uses during ordinary repository work.

Lead with the practical promise: less repeated investigation, better starting
context, and discoveries that survive a session. Explain the workflow before the
underlying data model:

1. An agent unfamiliar with the repository finds the relevant page and section.
2. It reads the explanation, follows supporting evidence, and accounts for main
   and local changes in its checkout.
3. It completes the coding task and records a useful discovery as a reflection.
4. Another agent can retrieve the pending discovery before the next update.
5. An update verifies and consolidates the discovery, then deletes its reflection.

Explain long-term, short-term, and working memory using those concrete steps.
Make clear that an incoming main change may not yet be in the agent's checkout,
and that a pending reflection is not automatically established knowledge.

The blog narrative should build on a demonstrated version of this experience.
Do not promise that the wiki is always current or that retrieval replaces source
verification. A full blog post is a separate artifact, not required to finish
this plan. Product documentation should describe shipped behavior once the
features are implemented and verified.

### End-to-end validation and completion criteria

Use representative repository tasks and the implemented host integration to
verify that an agent can discover the tools and follow the complete workflow.
Keep checks focused on the agreed behavior; no separate benchmarking or telemetry
system is required.

Confirm that:

- Managed `AGENTS.md` and `CLAUDE.md` blocks independently explain the tools,
  preserve user content, and contain no OpenWiki-owned cross-file dependency.
- A task can go from orientation to selected prose and evidence, while an agent
  with a known page or section can read it directly.
- Main changes both before and after incorporation into the checkout are
  distinguished from subsequent working changes, with relevant page, section,
  and claim connections.
- A new reflection is retrievable locally and remains retrievable after it
  travels through a PR into main, without duplicating it across memory layers.
- An update handles every starting reflection: useful findings become maintained
  knowledge, duplicates and unsupported findings are removed after evaluation,
  and successfully processed files disappear.
- Validation feedback allows correction and retry; failed processing preserves
  pending reflections and completed page work. New reflections arriving during
  an update remain for the next update.
- Published setup instructions and examples match the actual tool inputs,
  outputs, and behavior.

Phase 6 is complete when the agent guidance, product documentation, and this
workflow agree and the relevant end-to-end checks pass. Document material gaps
found during validation rather than adding unsupported claims to the introduction.

## Scope and completion

Validate each phase as it is built; end-to-end validation in phase 6 complements
those checks. Multi-wiki support and cross-wiki linking are outside this scope.

All six phases are implemented and validated. The documentation and installed
integration check follow the complete user story, with validation limits stated
above. Explicit deferred details remain outside the agreed implementation scope.
Release preparation and the full blog post are separate work; completing this
plan does not publish either artifact.
