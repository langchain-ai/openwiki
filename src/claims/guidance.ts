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
 * Shared model-facing rules for sparse reconciliation against existing Claims.
 */
export const CLAIMS_RECONCILIATION_GUIDANCE = `Claims reconciliation rules:
- Treat a stale or unresolved marker as a requirement to recheck current source, not as an instruction to retract the Claim automatically.
- Existing issue-free Claims are retained automatically when omitted from the submission. Do not repeat their statements or evidence.
- Every stale or unresolved Claim shown in the job must receive one explicit decision: put its id in confirmedClaimIds after verifying it remains accurate, submit a revised Claim with the same id in claims, or put its id in retractedClaimIds after removing or correcting the corresponding prose.
- If an otherwise-current existing Claim must change, inspect the page's complete Claims on demand, then submit only that revised Claim with its existing id. If it is no longer true, material, or asserted by the page, remove or correct the prose and put its id in retractedClaimIds.
- Submit every genuinely new material proposition in claims without an id. Never paraphrase or resubmit an unchanged Claim.
- The final page body and reconciled Claim set must agree.`;
