# OpenWiki optimization loop: Koota DeepSWE

## Objective and protocol

Primary objectives, in order: preserve or improve task score, then reduce coding-agent tokens and total tool calls. Wiki-generation tokens are excluded. Retrieval calls, returned characters, edit actions, and duration are diagnostic metrics.

Each hypothesis is cumulative unless its result causes an explicit rollback. The discriminator is `koota-pair-relation-tracking`, run three times concurrently with Codex `gpt-5.6-terra`, high reasoning, and OpenAI semantic reranking. This task was selected because it separates the old and current OpenWiki cohorts and exposes semantic-modeling failures rather than basic navigation failures. After five iterations, the best configuration is run on all five Koota tasks with three attempts each.

Runs stop for rate limits only after logs confirm a provider or HTTP 429. Infrastructure failures are diagnosed separately.

## Reference cohorts

| Cohort                     | Full solves | Mean partial | Uncached input/trial | Cumulative input/trial | Output/trial | Tool calls/trial | Retrieval calls/trial | Retrieval chars/trial | Edit actions/trial |
| -------------------------- | ----------: | -----------: | -------------------: | ---------------------: | -----------: | ---------------: | --------------------: | --------------------: | -----------------: |
| Baseline, 15 valid         |        3/15 |     0.989192 |              100,184 |              4,175,334 |       30,345 |            51.13 |                  0.00 |                     0 |               23.2 |
| Old OpenWiki, 15 valid     |        6/15 |     0.992832 |              136,772 |              5,192,270 |       30,478 |            57.93 |                  9.00 |                70,413 |               16.0 |
| Current OpenWiki, 15 valid |        4/15 |     0.984533 |              125,617 |              5,838,432 |       32,721 |            60.73 |                  5.73 |                30,650 |               21.0 |

The current retrieval surface eliminated invalid calls, cut retrieval calls 36%, retrieval payload 57%, broad `rg` 83%, and validation commands 26%. Those savings were outweighed by 75 additional edit actions across the cohort. Pair tracking was the dominant regression: old OpenWiki solved 1/3 with 0.9968 mean partial; current OpenWiki solved 0/3 with 0.9508 mean partial.

## Hypothesis 1: explicit state model, one canonical ledger, less prompt duplication

### Proposed change

- Before editing stateful behavior, require a compact model of all state identity axes, transitions, observation/reset windows, and the canonical owner or event ledger.
- Require explicit input/event/expected-result oracle rows mapped to focused tests.
- Remove the eval adapter's duplicated workflow essay and defer to the generated `AGENTS.md`, keeping only quickstart, read-only retrieval, and filesystem-isolation instructions.

### Expected benefit

The old full-solving pair trace centralized events by tracker/factory, entity, relation, and target. Current failures distributed state across modifier, trait, and query call sites, causing coexistence, cancellation, composition, and observation-window bugs. Making the design checkpoint salient should improve correctness and reduce edit churn without adding retrieval calls or payload.

### Outcome

H1 recovered quality and sharply reduced cost relative to the current pair cohort:

| Metric                 | Current pair |        H1 |    Change |
| ---------------------- | -----------: | --------: | --------: |
| Full solves            |          0/3 |       1/3 |  +1 solve |
| Mean partial           |     0.950794 |  0.990476 | +0.039683 |
| Uncached input/trial   |      153,744 |   129,476 |    -15.8% |
| Cumulative input/trial |    8,042,262 | 5,746,183 |    -28.6% |
| Output/trial           |       37,320 |    37,573 |     +0.7% |
| Exec/apply calls/trial |        71.67 |     61.33 |    -14.4% |
| Retrieval calls/trial  |         6.00 |      3.00 |    -50.0% |
| Retrieval chars/trial  |       30,603 |    21,697 |    -29.1% |
| Edit actions/trial     |        24.00 |     23.67 |     -1.4% |
| Tool calls/trial       |        77.67 |     64.33 |    -17.2% |

The full solve made only `change_surface` and `trace_symbols` retrieval calls and created a centralized pair-tracking module. The other attempts missed one coexistence case and five removal/lifecycle cases respectively.

The intended state-model guidance was not actually tested: all traces read upstream `/app/AGENTS.md`, while OpenWiki had written its managed block to the isolated `/tmp/openwiki-source/AGENTS.md`. The shorter treatment prompt therefore acted as a low-guidance/retrieval-restraint ablation. Its efficiency result is useful, but its quality gain cannot be attributed to the new managed prompt.

## Hypothesis 2: make the generated state-model guidance visible

### Proposed change

Point the concise treatment instruction directly to `/tmp/openwiki-source/AGENTS.md` after the quickstart. Keep the long workflow out of the task prompt and retain the `/app` source-of-truth boundary.

### Expected benefit

One small file read should expose the identity-axis, canonical-ledger, observation-window, and explicit-oracle checkpoint. This should turn more attempts into the centralized architecture seen in both full solves and close the coexistence/removal gaps, with much less context cost than restoring the duplicated treatment essay.

### Outcome

All three traces read the generated managed block, so the hypothesis was tested. It was a loss:

| Metric                 |        H1 |        H2 |    Change |
| ---------------------- | --------: | --------: | --------: |
| Full solves            |       1/3 |       0/3 |  -1 solve |
| Mean partial           |  0.990476 |  0.973016 | -0.017460 |
| Uncached input/trial   |   129,476 |   153,067 |    +18.2% |
| Cumulative input/trial | 5,746,183 | 6,980,095 |    +21.5% |
| Output/trial           |    37,573 |    38,454 |     +2.3% |
| Exec/apply calls/trial |     61.33 |     66.33 |     +8.2% |
| Retrieval calls/trial  |      3.00 |      4.33 |    +44.4% |
| Retrieval chars/trial  |    21,697 |    25,776 |    +18.8% |
| Edit actions/trial     |     23.67 |     23.00 |     -2.8% |
| Tool calls/trial       |     64.33 |     70.67 |     +9.8% |

The visible block increased retrieval and validation but did not improve the semantic design. All three attempts created centralized pair-tracking utilities, yet all missed specific/non-last/wildcard removal, exclusive replacement, and destruction. One also missed trait-plus-pair coexistence. The abstract state-model instruction did not force agents to enumerate every mutation producer, and the long workflow diluted the key decision.

## Hypothesis 3: compact, producer-aware managed guidance

### Proposed change

Reduce the managed block from eleven workflow bullets to five decision rules. Make retrieval evidence-driven rather than routine. For stateful work, require tracing every mutation/event producer and the state consumer before selecting one state owner, followed by explicit behavior rows and focused quiet validation.

### Expected benefit

The shorter block should recover H1's lower tokens and calls while retaining a concrete design guardrail. Producer tracing directly targets H2's repeated removal/destruction/replacement failures, which came from updating state consumers without covering all relation mutation paths.

### Outcome

Aborted before any coding-agent model calls after the user clarified that regressions must be reverted before continuing. This proposal is not counted as one of the five evaluated hypotheses. H2's explicit generated-`AGENTS.md` read and this untested compact-prompt edit were both rolled back to the H1 winner.

## Hypothesis 3: transition-producer evidence in `change_surface`

### Proposed change

Starting from H1, keep the same three-tool surface and enhance the already-used `change_surface` response with one compact `state_transitions` group. It prioritizes authoritative add/remove/update/destroy/reset/defer/replacement producer code and excludes query-modifier consumers. The final `trace_symbols` schema is unchanged.

### Expected benefit

Every H1/H2 attempt already calls `change_surface`, so this should expose the relation removal, replacement, and destruction paths that repeated failures missed without adding a tool call. The payload increase is bounded to one short citation, avoiding H2's prompt and search overhead.

### Outcome

H3 is retained as the new winner:

| Metric                 |        H1 |        H3 |    Change |
| ---------------------- | --------: | --------: | --------: |
| Full solves            |       1/3 |       2/3 |  +1 solve |
| Mean partial           |  0.990476 |  0.990476 | unchanged |
| Uncached input/trial   |   129,476 |   122,029 |     -5.8% |
| Cumulative input/trial | 5,746,183 | 5,318,199 |     -7.4% |
| Output/trial           |    37,573 |    33,751 |    -10.2% |
| Exec/apply calls/trial |     61.33 |     61.33 | unchanged |
| Retrieval calls/trial  |      3.00 |      3.33 |    +11.1% |
| Retrieval chars/trial  |    21,697 |    18,742 |    -13.6% |
| Edit actions/trial     |     23.67 |     24.33 |     +2.8% |
| Tool calls/trial       |     64.33 |     64.67 |     +0.5% |

One full solve received `packages/core/src/trait/trait.ts` as transition evidence and inspected trait/relation producers before editing. The other full solve made no retrieval calls, so its success is run variance rather than a retrieval win. The failed trial received the same producer citation but still missed removal/destruction/coexistence, showing that the extra evidence is helpful for some trajectories but not sufficient. H3 is retained because solve count improved while all token metrics fell materially.

## Hypothesis 4: evidence-gap descriptions and smaller search payloads

### Proposed change

- Describe `change_surface` as a once-per-change evidence bundle that should be inspected before separate searches.
- Describe `search` as a tool for a specific unresolved gap, queried by symbol or observable behavior in the narrowest scope.
- Reduce search's default/maximum results from 5/10 to 4/6.

### Expected benefit

The two H3 retrieval users each made three searches returning about 14k characters after `change_surface`. Better descriptions should reduce redundant searches; the lower bound caps remaining payload while preserving top-ranked evidence. Score should remain unchanged.

### Outcome

H4 regressed and was rolled back before H5:

| Metric                 |        H3 |        H4 |    Change |
| ---------------------- | --------: | --------: | --------: |
| Full solves            |       2/3 |       0/3 | -2 solves |
| Mean partial           |  0.990476 |  0.977778 | -0.012698 |
| Uncached input/trial   |   122,029 |   164,467 |    +34.8% |
| Cumulative input/trial | 5,318,199 | 6,622,466 |    +24.5% |
| Output/trial           |    33,751 |    39,949 |    +18.4% |
| Exec/apply calls/trial |     61.33 |     68.67 |    +12.0% |
| Retrieval calls/trial  |      3.33 |      4.00 |    +20.0% |
| Retrieval chars/trial  |    18,742 |    22,752 |    +21.4% |
| Edit actions/trial     |     24.33 |     25.67 |     +5.5% |
| Tool calls/trial       |     64.67 |     72.67 |    +12.4% |

The six-result cap reduced each search response, and one attempt used only one search, but the cohort as a whole made more retrieval and command calls and spent substantially more tokens. Tool descriptions did not reliably prevent redundant search. Both H4 descriptions and limits were reverted to H3 values.

## Hypothesis 5: compact post-edit symbol traces

### Proposed change

Keep H3's pre-edit retrieval unchanged. Make `trace_symbols` return deduplicated path/line citations rather than repeated snippets, and reduce its per-group default/maximum from 4/6 to 2/3.

### Expected benefit

Trace output was the largest single retrieval response at 9-11k characters in H3. It occurs after implementation, and agents need group presence, paths, and missing groups—not duplicate source excerpts. Compaction should cut retrieval and input tokens without affecting solve quality or tool-call count.

### Outcome

H5 reduced trace payload but regressed the primary outcome, so it was rolled back:

| Metric                 |        H3 |        H5 |    Change |
| ---------------------- | --------: | --------: | --------: |
| Full solves            |       2/3 |       1/3 |  -1 solve |
| Mean partial           |  0.990476 |  0.987302 | -0.003175 |
| Uncached input/trial   |   122,029 |   119,204 |     -2.3% |
| Cumulative input/trial | 5,318,199 | 5,825,158 |     +9.5% |
| Output/trial           |    33,751 |    33,222 |     -1.6% |
| Exec/apply calls/trial |     61.33 |     64.67 |     +5.4% |
| Retrieval calls/trial  |      3.33 |      3.67 |    +10.0% |
| Retrieval chars/trial  |    18,742 |    13,226 |    -29.4% |
| Edit actions/trial     |     24.33 |     25.33 |     +4.1% |
| Tool calls/trial       |     64.67 |     68.33 |     +5.7% |

Per-call trace payload fell from 9-11k to 1.7-2.1k characters, proving the compaction mechanism worked. That local saving did not reduce cumulative context or calls, and solve quality fell. The compact citation type, lower trace limits, and description were reverted. H3 remains the winner.

## Winner selected for the full suite

H3 is the retained configuration: H1's concise eval treatment and three-tool workflow, plus one `state_transitions` producer citation in `change_surface`. H2, H4, and H5 were rolled back; the aborted compact-prompt run is excluded.

### Full five-task, three-attempt result

The winner run completed 15/15 valid trials with no infrastructure or rate-limit failures.

| Cohort           | Full solves | Mean partial | Uncached input/trial | Cumulative input/trial | Output/trial | Tool calls/trial | Retrieval calls/trial | Retrieval chars/trial | Edit actions/trial | Agent duration/trial |
| ---------------- | ----------: | -----------: | -------------------: | ---------------------: | -----------: | ---------------: | --------------------: | --------------------: | -----------------: | -------------------: |
| Baseline         |        3/15 |     0.989192 |              100,184 |              4,175,334 |       30,345 |            51.13 |                  0.00 |                     0 |              23.20 |               471.1s |
| Old OpenWiki     |        6/15 |     0.992832 |              136,772 |              5,192,270 |       30,478 |            57.93 |                  9.00 |                70,413 |              16.00 |               929.6s |
| Current OpenWiki |        4/15 |     0.984533 |              125,617 |              5,838,432 |       32,721 |            60.73 |                  5.73 |                30,650 |              21.00 |               841.0s |
| H3 winner        |    **7/15** | **0.994350** |              132,469 |              6,198,174 |       34,006 |            61.07 |              **3.20** |            **18,291** |              19.07 |           **599.7s** |

H3 has the best quality: +4 full solves over baseline, +1 over old OpenWiki, and +3 over current OpenWiki. Against current OpenWiki, it holds total tool calls nearly flat (+0.6%), cuts retrieval calls 44%, retrieval payload 40%, edit actions 9%, and agent duration 29%. The tradeoff is +5.5% uncached input, +6.2% cumulative input, and +3.9% output tokens. Against baseline, quality improves substantially but costs 32% more uncached input, 48% more cumulative input, and 19% more tool calls.

Tool-call accounting treats every Codex exec/apply invocation and every MCP retrieval as one call. Edit actions are already included in exec/apply calls and are reported separately as a churn diagnostic; they are not double-counted in total tool calls.

| Task              | Full solves | Mean partial | Uncached input | Cumulative input | Output | Tool calls | Retrieval calls | Retrieval chars | Edit actions | Agent duration |
| ----------------- | ----------: | -----------: | -------------: | ---------------: | -----: | ---------: | --------------: | --------------: | -----------: | -------------: |
| Composite aspects |         1/3 |     0.995516 |        157,513 |        8,609,858 | 45,190 |      80.67 |            3.67 |          18,540 |        30.33 |         764.7s |
| Deferred mutation |         3/3 |     1.000000 |        116,375 |        4,779,118 | 27,944 |      56.00 |            5.33 |          24,894 |        13.00 |         511.4s |
| Entity snapshots  |         2/3 |     0.994911 |         87,182 |        2,307,435 | 24,183 |      35.00 |            1.33 |          11,825 |         8.33 |         374.4s |
| Pair tracking     |         1/3 |     0.996825 |        165,004 |        9,510,027 | 39,297 |      80.00 |            3.00 |          20,210 |        25.67 |         720.6s |
| Query predicates  |         0/3 |     0.984496 |        136,271 |        5,784,433 | 33,415 |      53.67 |            2.67 |          15,988 |        18.00 |         627.7s |

Compared with old/current OpenWiki task solves, H3 improved composite aspects to 1/3 and deferred mutation to 3/3, retained 1/3 pair solves, and remained 0/3 on query predicates. Entity snapshots fell from 3/3 to 2/3; its one miss was limited to tag-relation omission and roundtrip world-diff identity.

The remaining failures are concentrated and consistent:

- Composite: constructor arity and one removed-constituent transition.
- Pair: trait-plus-pair or static-plus-temporal conjunction semantics.
- Query predicates: `Added`/`Removed`/`Changed(predicate)` observation windows and independent predicate trackers.
- Entity: tag-relation snapshot omission and exact roundtrip diff identity.

The strongest retained product change is transition-producer evidence inside the existing `change_surface` tool. The clearest negative finding is that more or more-forceful prompting did not help: making the long managed block visible increased tokens/calls and worsened score. Search-result caps and compact final tracing both reduced their local payloads but did not improve end-to-end efficiency or quality, so both were reverted.

## Hypothesis 6: deduplicated traces with preserved evidence

### Proposed change

Starting from H3, keep `trace_symbols`' original 4-default/6-maximum result limits, ranking, input schema, and tool description. Deduplicate exact path/line citations across batched symbols into a shared citation table. Preserve every symbol-to-category mapping with compact citation IDs, retain every missing-category signal, and include a short snippet on each citation that provides the first evidence for at least one non-empty category. Additional citations remain path/line-only.

### Expected benefit

H3 repeatedly returned the same export, initialization, and test citation—including the same 220-character snippet and metadata—for each symbol. H5 proved that trace compaction can reduce a 9–11k response to 1.7–2.1k characters, but it also lowered result limits and removed all evidence excerpts. H6 isolates the safer payload change: it should materially reduce trace characters while retaining H3's evidence breadth and enough source context to interpret every category. Because `trace_symbols` runs after implementation, score and pre-trace behavior should remain unchanged; total calls and cumulative tokens should not increase.

### Outcome

H6 regressed both quality and end-to-end efficiency, so the citation-table format was rolled back to H3:

| Metric                         |        H3 |        H6 | Change    |
| ------------------------------ | --------: | --------: | --------- |
| Full solves                    |       2/3 |       0/3 | -2 solves |
| Mean partial                   |  0.990476 |  0.969841 | -0.020635 |
| Uncached input/trial           |   122,029 |   194,493 | +59.4%    |
| Cumulative input/trial         | 5,318,199 | 7,652,008 | +43.9%    |
| Output/trial                   |    33,751 |    41,154 | +21.9%    |
| Successful command/edit events |     57.67 |     63.67 | +10.4%    |
| Retrieval calls/trial          |      3.33 |      3.67 | +10.0%    |
| Observed tool calls/trial      |     61.00 |     67.33 | +10.4%    |
| Retrieval chars/trial          |    18,742 |    17,926 | -4.4%     |
| Edit actions/trial             |     24.33 |     24.67 | +1.4%     |
| Agent duration/trial           |    684.2s |    858.7s | +25.5%    |

The observed-call rows use directly comparable completed Codex command, file-change, and MCP events. The earlier tables' exec/apply totals additionally include failed or no-op apply attempts that do not produce file-change events; H6 had 15 visible failed apply attempts versus nine in H3, reinforcing the churn regression.

The local trace saving was real. H3's two trace responses were 9.2k and 10.9k characters (10,069 mean); all three H6 responses were 6.2–7.4k (6,716 mean), a 33.3% reduction. That was materially smaller than H5's 1.7–2.1k responses because 16–20 of H6's 16–21 unique citations still needed snippets: each was the first evidence for at least one symbol/category. The shared table mainly removed repeated citations and metadata while preserving H3's breadth.

That local saving did not translate into lower total context. All H6 agents continued working after tracing, making 2–3 more edits and 9–14 more commands; H3's trace users made 2–3 edits and 4–8 commands afterward. Two H6 trials missed specific/non-last/wildcard removal, exclusive replacement, and destruction. The third also missed specific/wildcard Added, `Or` and trait composition, cache isolation, and per-target result data. The extra tokens therefore came primarily from longer implementation, failed patch, validation, documentation, and publish-surface loops—not from consuming the trace response itself.

Because tracing occurred late and the cohorts used different trajectories, this run does not prove that citation IDs caused the failures. It does prove that the partially compact representation is not a safe end-to-end win under the project's rollback criterion. H6 was reverted; H3 remains the retained configuration.

## OpenWiki-20 optimization loop

The broader loop uses the completed 20-task baseline and 40-trial OpenWiki cohort. Each discriminator is run twice. A hypothesis is retained only when it does not regress quality and improves coding-agent tokens, calls, or time; otherwise its product changes are reverted before the next hypothesis. Wiki-generation tokens remain excluded.

### Hypothesis 1: task-first change-surface ranking

#### Proposed change

- Rank implementation evidence from the original task language, using generated-wiki paths only as a prior.
- Stop expanding the source query with every generic token from related wiki prose; retain only explicitly formatted symbols.
- Rank the tests group independently against the task instead of accepting whichever test happened to rank in the global source list.
- Exclude repository instruction files from change-surface evidence.

#### Expected benefit

The Helm failure received `AGENTS.md`, `pkg/cmd/root.go`, and an unrelated downloader test from `change_surface`, then widened a CLI presentation change into persisted release and Kubernetes lifecycle semantics. More precise task and test citations should reduce wrong-boundary edits and duplicate exploration. The main discriminator is Helm; Scriggo checks whether negative/parser tests become easier to locate.

#### Success gate

Across n=2 discriminator runs, preserve or improve mean partial score and full solves while reducing mean uncached or cumulative input and total tool calls. Inspect the returned citations directly. Revert if quality regresses or end-to-end efficiency does not improve.

#### Outcome

H1 achieved perfect discriminator quality but missed the efficiency gate, so it is retained only as the quality base for subsequent hypotheses. Across four valid trials (the infrastructure-failed wiki setup was replaced), it solved 4/4 with 1.000000 mean partial. It averaged 182,820 uncached input tokens, 16,368,626 cumulative input tokens, 46,168 output tokens, 109.25 observed tool calls, 3.25 retrieval calls, and 27.5 edit actions. Relative to the prior OpenWiki pair, it improved 2/4 full solves to 4/4 but increased uncached input about 6.7% and calls about 7.6%. Trace inspection showed agents recovered from still-poor initial citations through extra targeted search and validation; H1 alone does not beat the baseline on efficiency.

### Hypothesis 2: unique change-surface evidence budget

#### Proposed change

Keep H1's task-first ranking, independent test ranking, and instruction-file exclusion, but deduplicate citations across `change_surface` groups. Preserve category coverage and the seven-result budget; when one chunk qualifies for multiple groups, keep its first category and advance the later group to its next distinct citation. Leave `trace_symbols` unchanged because earlier trace compaction regressed.

#### Expected benefit

The H1 Helm retry returned seven category slots but only four unique files: `pkg/cmd/root.go` and `pkg/cmd/install.go` each appeared twice. That crowded out task-named surfaces such as `template.go`, `upgrade.go`, and `get_manifest.go`, after which the agent performed manual searches. Seven distinct citations should expose more of the change boundary in the already-required pre-edit call, reducing follow-up searches and commands without increasing retrieval payload or changing prompt behavior.

#### Success gate

Across n=2 discriminator runs, preserve H1's score while reducing mean retrieval calls, total tool calls, or uncached/cumulative input. Inspect the actual citations and verify that `trace_symbols` output is unchanged. Revert if quality regresses or the unique evidence does not reduce end-to-end work.

#### Outcome

H2 failed the quality gate and was rolled back before H3. It solved only 1/4 with 0.853724 mean partial versus H1's 4/4 and 1.000000. It did reduce mean uncached input from 182,820 to 155,579 (-14.9%) and observed calls from 109.25 to 86.0 (-21.3%), proving that a broader set of distinct citations can shorten trajectories. The savings are unusable because both Scriggo trials and one Helm trial lost full solves. Deduplication worked mechanically, but the distinct evidence was still poorly ranked, including CLI help/generator files and unrelated checker tests. The agents then performed deep compiler/runtime discovery and debugging themselves; no H2 product code is retained.

### Hypothesis 3: literal and path-aware change-surface ranking

#### Proposed change

Retain H1 but use literal-token BM25 and keyword rankers for `change_surface` source and test evidence. Keep synonym expansion for general `search`, semantic fallback, OKF concept discovery, and symbol tracing. Preserve the generated wiki's explicit referenced paths as a strong prior, so documentation still connects concepts to code without expanding task words into unrelated source vocabulary.

#### Expected benefit

H1 and H2 returned irrelevant Scriggo CLI help/generator files and unrelated tests because source ranking expanded generic query terms through broad synonym groups such as API/public/publish and setup/register. Literal task terms plus wiki path priors should favor task-named compiler, runtime, command, and test paths; that should reduce compensating searches and deep exploratory reads while preserving the quality gains of H1.

#### Success gate

Run Helm and Scriggo n=2 with all four trials concurrent. Preserve H1's full-solve count and improve mean uncached/cumulative input or observed tool calls. Revert H3 if quality regresses or ranking precision fails to improve end-to-end efficiency.

#### Outcome

H3 failed the quality gate and was rolled back. Its first completed Scriggo verifier scored only 0.624430 partial versus H1's 1.000000 in both trials. Literal ranking also failed its intended mechanism check: Helm still over-ranked `pkg/cmd/root.go`, while Scriggo returned renderer, CLI help, and unrelated multi-file template evidence rather than the method checker/emitter/runtime boundary. Frozen H3 trials continue only for diagnostic completeness; no H3 product code is retained.

### Hypothesis 4: bounded retrieval-first workflow

#### Proposed change

Keep H1's task-first `change_surface` ranking, but replace the eval adapter's mandatory quickstart read with one bounded pre-edit `change_surface` brief. Ask the agent to inspect the cited source and tests, avoid separately reading the quickstart or linked wiki pages unless a specific evidence gap remains, stop discovery after locating the implementation, affected public/generated surface, and focused tests, and avoid unrelated broad validation after focused checks pass.

#### Expected benefit

The expensive Effect, Adaptix, and Koota traces read the quickstart, multiple full wiki pages, generated instructions, and overlapping retrieval before repeating broad source discovery. The efficient Helm and KGateway traces stopped much earlier once the correct surface was known. A single documentation-backed evidence bundle plus an explicit stop rule should retain OpenWiki's cross-boundary quality advantage while removing duplicate context, search, and validation calls.

#### Success gate

Run Effect, Adaptix, Prometheus, and KGateway twice each with all eight trials concurrent. Preserve or improve the baseline's aggregate quality on this mixed discriminator while bringing mean uncached input and observed tool calls down relative to H1; inspect whether full-page wiki reads and overlapping retrieval disappear. Revert the prompt if quality regresses. Only promote it to generated product guidance if it passes.

#### Outcome

H4 is retained as the new quality-and-call base, but it does not yet pass the token gate:

| Metric                     | H4 result |
| -------------------------- | --------: |
| Full solves                |       4/8 |
| Mean partial               |  0.992970 |
| Median partial             |  0.999641 |
| Uncached input/trial       |   138,969 |
| Cumulative input/trial     | 8,834,009 |
| Output/trial               |    28,231 |
| Observed tool calls/trial  |     70.75 |
| Retrieval calls/trial      |     2.125 |
| Direct wiki reads/trial    |      0.00 |
| Command-output chars/trial |   957,332 |

Against the matched one-attempt baseline for Adaptix, Effect, Prometheus, and KGateway, H4 improved full solves from 1/4 to 4/8 and mean partial from 0.980085 to 0.992970. It reduced observed calls from 74.25 to 70.75, but uncached input remained 16.0% above the matched 119,866-token baseline and 25.1% above the overall 111,080-token baseline. Relative to H1 on these tasks, H4 removed every direct wiki-page read, cut retrieval to about two calls, substantially shortened each trajectory, recovered Effect from 0.598291 to 0.974359/1.000000, and reduced tokens; the remaining cost is no longer duplicate wiki consumption.

The dominant residual signal is command payload. H4 averaged 957k command-output characters per trial. Agents still dumped large source windows and consumed verbose test, generation, type-check, and build output. Effect averaged 194,814 uncached tokens despite one full solve; one KGateway trial spent extra calls and context recovering from a broad generation command. H4's workflow constraint worked, but it did not bound evidence size within each command.

### Hypothesis 5: bounded source and validation output

#### Proposed change

Retain H4 and require symbol-first, line-bounded source reads: inspect the cited range or a symbol-sized window of at most about 200 lines per command rather than dumping whole large files. Prefer repository-supported quiet validation flags. When unavailable, capture only test/build output in a short-lived task-local log, emit one concise success line or the relevant failure tail, delete the log immediately, and never redirect credential, environment, or configuration output.

#### Expected benefit

H4 already brings calls below the matched baseline, so further mandatory retrieval or fewer tools would target the wrong variable. Bounding per-call evidence should reduce uncached and cumulative context without removing source authority, tests, or failure diagnostics. It directly targets Effect's large multi-file reads and noisy package checks and KGateway's generation/test output while preserving H4's quality gains.

#### Success gate

Run the same four-task discriminator twice with all eight trials concurrent. Preserve H4's quality advantage over the matched baseline and keep observed calls at or below 75.2 per task. Reduce mean uncached input materially toward or below 111.1k, with lower command-output characters. Revert H5's output-budget instructions if quality regresses.

#### Outcome

H5 failed the quality and call gates and was rolled back. Across eight valid
trials it solved 2/8 with 0.975765 mean partial, versus H4's 4/8 and 0.992970.
It reduced uncached input to 120,576 tokens per trial, but observed calls rose
to roughly 77 per trial. Prometheus fell to 0.938144 in both attempts and
Effect remained partial in both attempts. Trace inspection showed that agents
ignored several source/output limits, launched overlapping checks, polled
background jobs, and collided on temporary logs. Smaller command responses did
not compensate for the added validation and recovery work, so none of H5's
source-window or temporary-log instructions is retained.

### Hypothesis 7: serialized quiet final validation

#### Proposed change

Build on H4 and full compound-aware retrieval, but isolate the safe part of
H5's output idea. After focused checks pass, run repository-required final
test, lint, typecheck, build, and documentation commands once and serially.
Capture each command's output separately and expose only a one-line success or
the relevant failure tail. Explicitly avoid overlapping validation and
`sleep`/`ps` polling. Do not cap source reads, reuse one shared temporary log,
or require log deletion.

#### Expected benefit

Effect's own `AGENTS.md` mandates root lint, check, build, and docgen, so those
commands cannot simply be skipped. H4/H6 traces repeatedly launched them in
parallel, consumed megabytes of successful build output, hit memory pressure,
and spent additional calls polling background processes. Serial quiet checks
should preserve required validation and solve quality while reducing uncached
context, tool calls, and retry churn. Removing H5's source cap isolates output
control from the Prometheus quality regression.

#### Success gate

Run Effect and Prometheus twice each. Preserve at least H4's two full solves and
0.9884 matched mean partial score while reducing uncached tokens and keeping
observed calls at or below 75.2 per task. Inspect traces for overlapping checks,
polling commands, and validation-output characters. Revert the prompt if
quality regresses or agents do not follow it.

#### Outcome

H7 failed the quality gate and its prompt-only change was rolled back. One
Effect trial failed during agent setup before any model call and was excluded.
The three valid trials produced no full solves: Prometheus scored 0.989691 in
both attempts and Effect scored 0.974359, for 0.984580 mean partial. A
replacement Effect trial was not run because even a perfect result could reach
only 1/4 full solves, below H4's required 2/4.

The mechanism worked locally: traces contained no `sleep`/`ps` polling or
overlapping background validation. Relative to the four matched H4 Effect and
Prometheus trials, the three valid H7 trials reduced mean uncached input from
153,507 to 113,415, cumulative input from 9,067,200 to 7,427,668, and command
output from about 364k to 271k extracted characters. Observed calls also fell
from about 75 to 70 per trial. Those aggregate savings were concentrated in
Prometheus. Effect still made 111 observed calls, repeated focused lint/tests
while fixing real failures, and took about 32 minutes of coding time. Quiet
serial validation therefore reduced successful-command noise but did not
prevent implementation/debugging loops, and the quality regression makes the
savings unusable.

### Hypothesis 6a: snake-only lexical boundaries

#### Proposed change

Partially roll back Hypothesis 6 after its first valid Effect trial regressed.
Keep underscore boundary splitting, which directly improved Adaptix's
`name_mapping` to `NameMapping` evidence, but restore the prior joined-token
behavior for hyphenated terms. This prevents H6 from changing ranking for
Effect task phrases such as `text/event-stream`, `no-cache`, and `keep-alive`.
All other H4 behavior remains unchanged.

#### Expected benefit

The full compound change produced 2/2 Adaptix solves while reducing Adaptix
mean uncached input from 119.4k to 116.4k and observed calls from 63.5 to 50.
Its first valid Effect result fell to 0.9487, below H4's 0.9744 and 1.0.
Snake-only normalization should preserve the measured Adaptix improvement while
removing the only lexical change relevant to the Effect task.

#### Success gate

Run Adaptix and Effect twice each. Preserve H4's aggregate quality and retain
the Adaptix token/call improvement. Revert underscore splitting as well if the
quality regression persists.

#### Outcome

H6a was a clear regression and was rolled back. It solved 1/4 with 0.886662
mean partial, 129,513 uncached input tokens, and 79.5 observed calls per trial.
Adaptix retained one full solve plus a 0.999641 partial, but Effect scored
0.948718 and 0.598291. Snake-only splitting did not isolate the Effect
regression and also lost one Adaptix full solve, so full underscore-and-hyphen
compound normalization was restored.

### Hypothesis 6: compound-aware lexical retrieval

#### Proposed change

Retain H4's bounded retrieval-first workflow and task-first `change_surface`
ranking, but normalize snake_case and kebab-case boundaries the same way as
camelCase and PascalCase boundaries. For example, `name_mapping`,
`name-mapping`, and `NameMapping` should all contribute the terms `name` and
`mapping` instead of producing incompatible `namemapping` versus
`name`/`mapping` tokens. Leave synonym expansion, result limits, semantic
fallback, and tool descriptions unchanged.

#### Expected benefit

Generated wiki prose and benchmark tasks frequently use snake_case or
hyphenated API names while source symbols use camel case. The current mismatch
silently weakens both BM25 and keyword ranking, forcing agents to compensate
with manual source searches. Fixing the lexical boundary should improve the
already-required `change_surface` evidence without another tool call or a
larger response. Adaptix is the primary discriminator because `name_mapping`
must resolve to `NameMapping`; Effect provides a second compound-heavy check.

#### Success gate

Run Adaptix and Effect twice each, with all four trials concurrent. Preserve
H4's aggregate quality while reducing uncached input, cumulative input, or
observed calls. Inspect `change_surface` citations to confirm the compound
match changed the returned evidence. Revert if quality regresses or retrieval
precision does not improve end-to-end efficiency.

#### Outcome

H6 is retained. After replacing one infrastructure-failed Effect setup, the
four valid trials solved 3/4 with 0.987179 mean partial. Adaptix improved to 2/2
full solves while averaging about 116.4k uncached tokens and 50 observed calls.
Effect produced one full solve and one 0.948718 partial. Across both tasks H6
averaged about 136.0k uncached tokens and 67.75 calls, reducing each by roughly
13-14% from the matched H4 trials. H6a's failed ablation strengthened the
evidence that normalizing both snake_case and kebab-case boundaries is the
better retained retrieval behavior, despite remaining Effect variance.

### Hypothesis 8: OKF metadata-routed task briefs

#### Proposed change

Replace broad wiki prose retrieval with one compact `change_surface` brief:
implementation ownership, explicit invariants, analogous tests, conditional
delivery surfaces, validation commands, unknowns, and a changed-path coverage
review. Treat OKF descriptions and inferred document roles as routing signals,
tags as weighted facets rather than graph edges, and explicit Markdown links as
relationships. Add a type-checked `openwiki` frontmatter extension for future
generated wikis (`roles`, `change_kinds`, `source_paths`, `symbols`,
`test_paths`, `invariants`, and `validation_commands`). Shorten the managed
AGENTS guidance so agents use the brief only when it can replace exploration,
inspect cited source/tests directly, and avoid rereading returned wiki pages.

#### Expected benefit

The previous workflow added a parallel wiki-reading phase. A small structured
brief should substitute for broad source discovery, make uncertainty explicit,
and use the existing OKF metadata as a cheap retrieval control plane. It should
reduce direct OpenWiki payload, redundant filesystem wiki reads, total calls,
and context while preserving or improving quality.

#### Success gate

Run the same 14-task fast subset at n=2 with cached wiki Markdown and all trials
parallel. Preserve or improve the prior 9/28 full solves and 0.965895 mean
partial score while reducing tokens and calls. Require compatible caches so the
experiment changes retrieval/runtime behavior without paying for or changing
wiki generation. If preliminary valid trials show no quality improvement, do
not spend tokens replacing infrastructure failures.

#### Outcome

The quality gate failed, so six Docker-subnet setup failures were not rerun.
The 22 valid trials solved 7/22 (31.8%) with 0.934685 mean and 0.994733 median
partial score. The prior OpenWiki cohort solved 9/28 (32.1%) with 0.965895 mean
partial, and baseline solved 10/28 (35.7%) with 0.969366 mean partial. One
deferred-mutation trial scored 0.030151 while its replicate fully solved,
accounting for most of the mean regression, but the aggregate solve rate still
showed no improvement.

The 22 valid trials averaged 117,522 uncached input tokens, 6.264M cumulative
input, 30,355 output tokens, and 61.32 observed calls. Relative to prior
OpenWiki task means reweighted to the same 22-task composition, those are
improvements of 6.4%, 4.5%, 2.4%, and 0.6%, respectively. OpenWiki use fell
from 3.54 to 2.36 calls per trial; direct estimated overhead fell from 7,799 to
4,738 tokens. Removing direct OpenWiki overhead leaves 6.290M total tokens and
58.95 calls per trial, still above baseline's same-task-weighted 4.689M total
tokens and 56.70 calls. The brief therefore became smaller and more
consistently consulted, but did not yet replace enough downstream exploration
or improve implementation quality.

The cached wikis predate the new namespaced `openwiki` extension, so this run
evaluated inferred roles, descriptions, tags, explicit links, retrieval output,
and AGENTS behavior—not producer-authored structured invariants, source paths,
test paths, or validation commands. A future clean generation experiment is
required to evaluate that half of the hypothesis.
