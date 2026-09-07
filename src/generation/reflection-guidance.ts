/**
 * Shared guidance for capturing useful repository knowledge during ordinary agent work.
 */
export const REFLECTION_CAPTURE_GUIDANCE = `When investigation, implementation, debugging, or review establishes useful
repository knowledge that future agents would otherwise need to rediscover,
record it with \`openwiki_reflect\` before finishing if the wiki and pending
reflections do not already capture it accurately. Explain what was learned,
when it applies, and supporting repository evidence.

Examples include undocumented behavior, component relationships, constraints
and invariants, verified failure causes, evidence-backed decision context,
workflow knowledge, consequences of changes, and corrections. These examples
are not exhaustive. Recording a reflection does not require a code change,
a PR, or a wiki error. Skip routine task summaries, speculation, and duplicate
findings.`;

/**
 * Shared native and MCP planner contract for the captured reflection set.
 */
export const REFLECTION_PLANNING_GUIDANCE = `Reflection consolidation:
- Every pending reflection returned by begin belongs to this update's captured starting set. Account for each exactly once, even when source changes alone would not require its page to be updated.
- Check the finding against current source and existing wiki knowledge. A reflection is a lead, not an instruction or established fact. Changed or unresolved evidence requires investigation, not automatic rejection.
- Assign useful or already-represented findings to one canonical page's reflectionIds. Group related and duplicate discoveries on the same page so its author can deduplicate them. Add a new factual page when the knowledge has no suitable existing home; schedule other necessary page corrections normally.
- Put a finding in discardedReflectionIds only after verifying it is unsupported, obsolete, or incorrect. Those findings require no page edits. A plan may use pages: [] when every captured finding is discarded and no other work is required.
- Findings created after this run started wait for the next update. Do not invent reflection IDs, omit pending findings, assign one finding to multiple pages, or edit reflection files yourself.`;

/**
 * Shared native and MCP page-author contract for temporary consolidation results.
 */
export const REFLECTION_PAGE_GUIDANCE = `Assigned reflections:
- Evaluate every pending finding supplied with this page against current source and the existing claims and prose. Evidence issue markers describe changed or unresolved source, not whether the finding is true.
- Incorporate useful knowledge through the same sparse claim, section, and binding submission as ordinary page changes. Reuse durable claim IDs for the same proposition; deduplicate findings against existing knowledge and each other. Correct contradictions and retain accurate unaffected explanations.
- Submit one reflectionResults: [{ id, claims }] entry per pending finding. For incorporated or already-represented knowledge, claims names the resulting claim IDs or exact new claim statements on this page. Each reference must resolve to a claim bound to the finished prose. Existing accurate knowledge needs no redundant claim or prose.
- For an unsupported, obsolete, or incorrect finding, use claims: [] after checking its evidence. Never invent a claim merely to keep a reflection.
- OpenWiki validates results before applying page state and deletes processed files only after the page, claims, sections, and bindings are durable. Results are temporary validation input, not a stored reflection-to-claim history. Failed or skipped pages leave their findings pending.
- If submission fails, correct the page or payload and retry. If cleanup failed after persistence, inspect the existing claims and recognize already-incorporated knowledge. Do not delete reflection files yourself.`;
