# OpenWiki init reviewers

Use the host's native delegation mechanism for these independent, read-only
roles. If delegation is unavailable, run each role sequentially in the main
agent while preserving the same evidence boundary and output contract. Never
let a reviewer edit the plan or wiki.

## Contents

- [Skeleton critic](#skeleton-critic)
- [Question finder](#question-finder)
- [Answer verifier](#answer-verifier)
- [Verification waves](#verification-waves)

## Skeleton critic

Independently map the repository before reading `openwiki/_plan.md`. Inspect
manifests, entrypoints, public APIs, domains, state ownership, operations,
cross-system flows, and representative implementation and tests. Then compare
that inventory with the plan and identify every material missing or shallow
canonical home. Audit the proposed paths as a durable information architecture:
the root must not be a dumping ground when coherent domain groups exist, section
directories must have a real purpose and normally multiple substantive pages,
and the quickstart map must agree with the physical hierarchy. Treat avoidable
root-level sprawl, artificial single-page directories, generic catch-all
sections, and source-tree mirroring as material navigation defects rather than
stylistic preferences. Reject umbrella directories such as `architecture/`,
`core/`, or `platform/` when they collect independently owned subsystems, and
require every multi-page quickstart domain to correspond to its owning physical
directory. Every information-architecture request must name the exact planned
paths or domain ownership that should change so the parent can repair and freeze
the tree before authoring.

The initial review must return all material gaps in one response. The one repeat
review must verify every prior request against repository evidence. It may add a
new request only for a regression introduced by the revision, not a pre-existing
gap the initial audit should have found.

Return only:

```xml
<review status="PASS | CHANGES_REQUESTED">
  <prior_requests>
    <item id="RQ-01" status="VERIFIED | UNRESOLVED">
      <evidence>concise repository evidence</evidence>
    </item>
  </prior_requests>
  <new_requests>
    <item id="RQ-02">
      <gap>material coverage gap</gap>
      <evidence>paths, symbols, tests, or runtime flow</evidence>
      <required_change>specific plan change</required_change>
    </item>
  </new_requests>
</review>
```

Return `PASS` only when every prior request is verified and there are no new
requests. Do not request stylistic rewrites or describe adequate areas.

## Question finder

Read repository source and tests only; never read `openwiki/`. Generate realistic
debugging, maintenance, and extension questions that require understanding
behavior across meaningful boundaries. Each question must be grounded in exact
paths and symbols, contain three to five acceptance criteria, and avoid assuming
guarantees the source does not establish.

Return at most ten materially distinct questions, targeting eight for a large
repository and fewer when that gives sufficient coverage. Use stable IDs:

```text
[Q-01]: How does ...?
Acceptance criteria:
- Concrete behavior, boundary, invariant, failure, or focused-test requirement.
Source evidence:
- path/to/file.ts:Symbol — why this evidence motivates the question.
```

## Answer verifier

Read `openwiki/` only; never inspect source or tests. Verify a related batch of
one to three questions against every supplied acceptance criterion. Do not write
files, weaken criteria, infer missing behavior, or use source evidence included
with the question as an answer.

Status rules:

- `PASS`: every criterion is answered accurately and specifically.
- `PARTIAL`: at least one criterion is answered but material details are absent.
- `FAIL`: the wiki cannot provide a useful answer.

A documented evidence limit may satisfy a criterion when the wiki explicitly
states that source establishes no guarantee, behavior, or focused test. Return
only:

```xml
<results>
  <result id="Q-01" status="PASS | PARTIAL | FAIL">
    <missing>None | precise missing facts and relevant wiki pages</missing>
  </result>
</results>
```

On a retry, use only the unchanged question ID and text, its prior missing-items
list, and the wiki pages changed to address it. Verify those missing items; do
not expand the question.

## Verification waves

Before each wave, create the complete batch plan. Group questions sharing pages,
systems, or evidence into batches of two or three; use a singleton only when no
meaningful overlap exists. Launch all batches for a wave together when the host
supports parallel delegation.

After a wave, the main agent repairs every `PARTIAL` or `FAIL` result before any
retry. Retry only non-passing IDs and close each question TODO only after `PASS`.
