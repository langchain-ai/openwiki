/**
 * Shared model-facing standard for selecting substantive repository Claims.
 *
 * Keep this domain guidance shared by init, update, migration, and the tool
 * description so "atomic" never degrades into one shallow fact per symbol.
 */
export const CLAIMS_SUBSTANCE_GUIDANCE = `Claims substance standard:
- A Claim is an independently verifiable, evidence-backed proposition about the system. Claims should capture substantive system truths: responsibilities and observable behavior; architectural roles and ownership boundaries; data and control flow; relationships among components; invariants, lifecycle, ordering, and failure semantics; configuration, security, persistence, and operational behavior; and important extension boundaries.
- One function or component may support several Claims when each records a different substantive truth. Conversely, do not create a Claim merely because a symbol exists, accepts or returns a type, lives at a path, or extends a base class unless that fact materially changes how a reader understands, uses, operates, or safely changes the system.
- Atomic means one coherent, independently falsifiable idea, not one file, symbol, sentence, or source line. A single Claim may connect multiple components and cite multiple evidence resources when they jointly establish one relationship or end-to-end behavior.
- Every evidence resource MUST use the canonical \`repo://<repository-relative-path>\` form, optionally followed by a language-agnostic line range such as \`#L20-L48\`. Never submit a bare path such as \`src/agent/index.ts\`.
- Apply this materiality test: if the proposition were false, would it meaningfully change a reader's architectural model, implementation decision, operational expectation, or safe change plan? If not, omit it.
- Ensure every material, source-dependent proposition the wiki relies on is represented. Completeness takes priority over minimizing Claim count. Do not omit distinct truths merely because the same function or component already supports another Claim. After establishing coverage, remove semantically duplicate Claims and implementation trivia.`;

/**
 * Shared model-facing rules for reconciling a complete existing Claim set.
 *
 * Existing inspected Claims expose evidence as resource strings while page
 * submission accepts `{resource}` objects, so "unchanged" applies to the
 * resource values rather than the surrounding transport shape.
 */
export const CLAIMS_RECONCILIATION_GUIDANCE = `Claims reconciliation rules:
- Treat a stale or unresolved marker as a requirement to recheck current source, not as an instruction to retract the Claim automatically.
- For every existing Claim that remains accurate and materially represented by the page, submit the same Claim id and statement verbatim and preserve the same evidence resource values. This confirms the Claim and lets OpenWiki refresh code-owned evidence versions.
- If the same conceptual proposition changed, reuse its Claim id and change only the statement or evidence that current source requires. If its evidence moved, keep the id and cite the replacement resource.
- If an existing Claim is no longer true, no longer material, or no longer asserted by the page, correct or remove the corresponding prose and omit the Claim from submission. Omission retracts it. If a different proposition replaces it, submit that proposition as a new Claim without an id.
- Submit every genuinely new material proposition without an id. Do not paraphrase unchanged Claim statements, replace stable ids, or retain a Claim the final page no longer asserts.
- The final page body and complete submitted Claim set must agree.`;
