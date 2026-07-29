# OpenWiki trace findings: Koota DeepSWE

## Scope

This analysis compares 15 baseline and 15 OpenWiki trials: three attempts on each of five `pmndrs/koota` tasks. Wiki-generation tokens are excluded from the coding-agent token comparison. Wall-clock results are directionally useful but are confounded by concurrency, retries, and infrastructure variance.

## Executive diagnosis

OpenWiki improved full solves from **3/15 to 6/15** and reduced file-edit actions by **31%**. Its clearest benefit is better change-surface coverage: agents search less broadly, modify fewer files repeatedly, and more consistently validate package exports and consumer paths. It is most useful on changes that cross lifecycle, relation, and publish boundaries.

That gain currently costs context. OpenWiki increased uncached coding-agent input by **36.5%**, cumulative input by **24.4%**, and total tool calls from **52.3 to 57.9** per trial. Output tokens were essentially flat. The excess comes primarily from large retrieval responses, direct full-page wiki reads that duplicate retrieval, and verbose build/test output—not from longer reasoning or more editing.

The reported **35.5% lower mean end-to-end time should not yet be treated as a product claim**. The difficult pair, query, and composite tasks were much faster, but deferred mutation and entity snapshot were slower; run scheduling and infrastructure varied. A controlled sequential rerun is needed to isolate the effect.

## Changes applied from these findings

The retrieval and prompting changes are implemented but have not yet been re-evaluated on DeepSWE:

- The MCP surface is reduced from eight tools to `search`, `change_surface`, and batched `trace_symbols`.
- `search` automatically combines exact, BM25, semantic, and OKF ranking behind `all`, `wiki`, `source_code`, and `tests` scopes. Ranking implementation is no longer an agent choice.
- `tests` results include stable test names, deduplicate canonical/generated publish mirrors, and receive lifecycle/transition vocabulary expansion.
- `trace_symbols` accepts up to 12 plain or dotted identifiers, re-indexes once, deduplicates symbols, and returns one grouped audit.
- Limits are clamped to documented bounds instead of failing and forcing retries. Search payloads omit ranking diagnostics, snippets are shorter, and `change_surface` returns at most two related wiki concepts.
- Generated agent guidance now makes test-scoped search conditional, calls `change_surface` only for cross-boundary changes, performs one final symbol batch, avoids duplicate wiki/retrieval reads, and requests quiet focused validation.
- Wiki-generation guidance now asks for explicit observation windows, tracker identity, truth transitions, static-plus-temporal composition, net/coalesced deferred effects, unchanged-update behavior, constructor invariants, exact test names, and quiet validation commands.

## Where OpenWiki helped

| Signal                  | Baseline | OpenWiki | Interpretation                                       |
| ----------------------- | -------: | -------: | ---------------------------------------------------- |
| Full solves             |     3/15 |     6/15 | Promising quality improvement; sample is still small |
| Mean partial score      |   0.9892 |   0.9928 | Failures became narrower                             |
| File-edit actions/trial |     23.2 |     16.0 | Less rework and patch churn                          |
| `rg` commands/trial     |     4.93 |     2.40 | Retrieval replaced broad text search                 |
| Tool calls/trial        |     52.3 |     57.9 | Retrieval added more calls than it eliminated        |
| Uncached input          | baseline |   +36.5% | Retrieval remains too expensive                      |

The strongest task-level result was pair-relation tracking. Baseline trials failed across cancellation, exclusive replacement, destruction, wildcard removal, coexistence, and transition cases. OpenWiki narrowed this to one repeated mixed-requirement edge case and achieved one full solve. The traces show agents explicitly converting requirements into lifecycle checks, following the public package surface, and finding a bundler-only issue through consumer validation.

Entity snapshots improved from 2/3 to 3/3 solves. Deferred mutation improved from 1/3 to 2/3, although its remaining failure exposed unmodeled net/coalesced effects such as add→remove and remove→add. Composite-aspect failures narrowed to unchanged-update, constructor-arity, and one `Not(aspect)` transition edge.

## Where it did not help enough

Query predicates remained 0/3. All OpenWiki trials missed the held-out `Changed(predicate)` and `Removed(predicate)` truth-transition semantics; some also missed `Added(predicate)` and tracker independence. Agents found the right subsystem and wrote plausible tests, but their tests did not reproduce the verifier's observation-window behavior. This is a semantic-modeling and test-design failure, not a navigation failure.

The wiki should describe these runtime contracts explicitly:

- Observation-window boundaries: when added, removed, and changed state becomes visible and when it resets.
- Tracker identity and isolation across predicate/query instances.
- Truth-transition state machines, including false→true, true→false, and unchanged updates.
- The interaction between static query constraints and temporal tracking constraints.
- Net/coalesced effects of deferred and re-entrant mutations.
- No-op update semantics and constructor invariants for composed aspects.

These should be expressed as compact behavior matrices with links to authoritative source and focused tests. More architectural prose or more file snippets will not address the observed failures.

## Experiment verdicts

- **H1 surface gate and H2 OKF retrieval:** quality scores are invalid because these ran before patch transport was fixed. H2 still demonstrated a clear payload failure: `change_surface` returned 177k characters initially and 148k at final verification.
- **H3b compact retrieval plus `symbol_trace`:** compaction worked. `change_surface` fell to roughly 8–10k characters and the query task scored 39/43, but the run still used 126k uncached input tokens and 14 retrieval calls.
- **H4 behavior matrix:** the clearest win. It retained the same 39/43 score with 107k uncached input tokens and only five retrieval calls. Keep this policy.
- **H5 mandatory `test_search`:** no quality gain; the score remained 39/43 while uncached input rose to 130.5k and retrieval calls to nine. Keep test search optional until its precision improves.

## Retrieval-tool decisions

Across OpenWiki trials, retrieval was called 135 times, averaging nine calls and about 70k returned characters per trial. Fourteen calls (10.4%) were invalid because requested limits exceeded 20 or `symbol_trace` rejected dotted/multiple symbols. Fixing these retries is the first priority.

| Previous tool              |    Calls | Applied decision                                                                                               |
| -------------------------- | -------: | -------------------------------------------------------------------------------------------------------------- |
| `symbol_trace`             |       54 | Replaced by batched `trace_symbols`, including dotted names and one shared re-index                            |
| `change_surface`           |       32 | Retained with compact results; prompt use is limited to public/cross-package/generated/registration changes    |
| `test_search`              |       16 | Folded into `search(scope: "tests")`; use is conditional and results expose test names and deduplicate mirrors |
| `hybrid_search`            |       13 | Replaced by `search`; hybrid ranking remains the automatic default                                             |
| Keyword/BM25/OKF graph     | 20 total | Removed from the agent tool surface and retained as internal ranking engines                                   |
| Standalone semantic search |        0 | Removed from the tool surface; semantic ranking remains inside `search`                                        |

`symbol_trace` was overused: 29 of its 54 calls came from the entity-snapshot task. `change_surface` was commonly called twice and sometimes three times with overlapping results. The new surface represents three agent decisions—search, pre-edit change mapping, and post-edit batched verification—while scope selects the corpus without exposing ranking internals.

## Recommended next experiments

1. **Re-run the H4 policy with the new surface:** measure retrieval calls, invalid calls, payload characters, coding-agent tokens, edits, and score. Invalid retrieval calls should fall to zero.
2. **Validate compact retrieval:** target under 20k retrieval characters per trial without reducing solve rate or partial score.
3. **Ablate test scope:** compare conditional `search(scope: "tests")` against the same policy with test retrieval disabled.
4. **Use query predicates as the discriminator:** test whether new observation-window and tracker-state wiki content converts the repeated 39/43 result into a full solve.
5. **Measure batched tracing:** compare symbols per call, trace payload, and public-surface misses against the old per-symbol behavior.
6. **Repeat timing under controlled scheduling:** same task order, concurrency, warmup, and infrastructure; report medians and successful-trial timing separately.

The near-term objective should be to preserve OpenWiki's solve-rate and rework gains while removing duplicated context. The best current direction is **behavior-matrix prompting plus compact, workflow-oriented retrieval**, not mandatory use of more tools.
