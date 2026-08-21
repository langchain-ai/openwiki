---
"openwiki": minor
---

feat: rebuild init/update around a fanned-out authoring pipeline with a mechanically validated plan

- Authoring fans out: a `page-author` subagent, an authoring pool, and a shared dispatch path replace the coordinator writing pages on its own turn budget.
- The plan is a structured artifact rather than prose. A plan store carries the evidence each author needs, briefs are rendered from it, and a plan ledger validates coverage, decomposition, and page paths in code instead of asking the model to self-assess.
- The page floor is derived from source volume via a mechanical repository inventory, not from directory count.
- Claims for a page are established in one call, and prose plus Claims now succeed or fail together.
- Wiki verification and the skeleton critic treat under-decomposition and thin plans as defects.

Generated wikis change shape: page counts, page paths, and the plan format all differ from prior releases, and the init/update prompt and subagent contracts are rewritten. Re-running init against an existing wiki is the supported upgrade path.
