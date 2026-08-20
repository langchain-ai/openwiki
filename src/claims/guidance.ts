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
- Apply this materiality test: if the proposition were false, would it meaningfully change a reader's architectural model, implementation decision, operational expectation, or safe change plan? If not, omit it.
- Ensure every material, source-dependent proposition the wiki relies on is represented. Completeness takes priority over minimizing Claim count. Do not omit distinct truths merely because the same function or component already supports another Claim. After establishing coverage, remove semantically duplicate Claims and implementation trivia.`;
