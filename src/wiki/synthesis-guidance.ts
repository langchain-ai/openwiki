/**
 * Shared page-writing guidance reused across every place an agent writes or
 * updates a wiki page: per-source updates (ingestion.ts), graduation
 * (graduation.ts), and gap-fill (gap-fill.ts). Kept in one place so the rule
 * can't drift between call sites.
 */

/**
 * A page that only groups and cites evidence about a feature, with no
 * explanation of the feature itself, leaves a reader (or downstream agent)
 * asking "what does this do" with nowhere on the page to find out — even
 * when the source evidence actually supports answering it.
 */
export const CAPABILITY_DOC_GUIDANCE = `
- When the evidence describes a feature, capability, or procedure (not only a report of a problem with one), the page must explain the thing itself, not only catalog evidence about it: include what it is, what it currently can and cannot do, and concrete step-by-step instructions when the evidence describes how to do something. A page that only groups and cites tickets about a feature, with no explanation of the feature itself, is incomplete — synthesize the underlying knowledge the evidence reveals, don't just index it.
- This does not apply to purely incident/issue-shaped evidence with no feature-level content to synthesize (e.g. a page consolidating unrelated bug reports) — do not invent capabilities or steps that no evidence actually supports.
`.trim();
