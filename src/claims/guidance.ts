/**
 * Shared model-facing standard for selecting substantive repository Claims.
 *
 * Keep this domain guidance shared by init, update, migration, and the tool
 * description so "atomic" never degrades into one shallow fact per symbol.
 */
export const CLAIMS_SUBSTANCE_GUIDANCE = `Claims substance standard:
- A Claim is an independently verifiable, evidence-backed proposition about the system. Claims should capture substantive system truths: responsibilities and observable behavior; architectural roles and ownership boundaries; data and control flow; relationships among components; invariants, lifecycle, ordering, and failure semantics; configuration, security, persistence, and operational behavior; and important extension boundaries.
- One function or component may support several Claims when each records a different substantive truth. Conversely, do not create a Claim merely because a symbol exists, accepts or returns a type, lives at a path, or extends a base class unless that fact materially changes how a reader understands, uses, operates, or safely changes the system.
- Atomic means one coherent, independently falsifiable idea, not one file, symbol, sentence, or source line. A single Claim may connect multiple components and cite multiple evidence resources when they jointly establish one relationship or end-to-end behavior. Keep independently changeable contracts separate: orient's directory, outline's section descriptions, and read's selected prose belong in separate Claims when documenting each tool's behavior.
- Preserve the conditions and exceptions established by source in both the Claim and prose. For example, incorporated or duplicate reflections reference resulting Claims, while discarded findings may use an empty result. Do not broaden this into "every processed reflection must reference a Claim."
- Verify documented commands against their scripts and implementation, including prerequisites. A test that launches an already-built CLI requires a build beforehand; it does not itself build the CLI unless its code performs that step.
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

/**
 * Shared authoring contract for durable sections and exact prose bindings.
 */
export const PROSE_RECONCILIATION_GUIDANCE = `Sections and prose bindings:
- Submit sparse sections, removedSectionIds, bindings, and removedBindingIds alongside Claim decisions. Omitted records are retained, but every resulting connection is validated against the finished page.
- Each section has a stable OpenWiki-generated id, location, and description. Add sections without ids; revise existing sections using their ids. Describe every Markdown heading, including the page title. A non-empty introduction before any heading uses the page path alone.
- A section location is the wiki-relative page plus its heading ancestry separated by #, for example transactions.md#Transactions#FailureHandling. Remove whitespace from each heading component, preserve case and Markdown inline syntax, and percent-encode reserved URI characters (including literal # and %). Rename ambiguous heading paths rather than guessing or using line numbers. Update a renamed section's location while retaining its id.
- Descriptions explain what each section covers so a future agent can choose what to read. Review descriptions when section scope changes; do not rewrite accurate descriptions merely because prose changed.
- A proposed binding has an optional existing id, section, text, and claims. section accepts an existing section ID or the exact location of a new section. claims accepts existing Claim IDs or exact statements of new Claims. OpenWiki resolves these references to sectionId and claimIds before persistence; never invent durable IDs.
- text must be an exact, unambiguous passage in that section's direct body, excluding the heading and nested sections. LF and CRLF line endings are equivalent; other whitespace is significant. Keep Markdown plain; do not embed claim links or hidden markers.
- Bind every retained material Claim to the passage or passages expressing it. One passage may express several Claims and a Claim may occur in several passages. Review all bound passages for a stale Claim before confirming, revising, or retracting it.
- Inspect the current page's complete Claims and prose metadata when IDs for otherwise-current edits are needed. When a legacy page has no sections or bindings, establish them during its next submitted update.
- If a passage moves to another section, update its binding's section reference. If prose disappears or a Claim is retracted, update or remove affected bindings. Explicitly remove deleted sections and their obsolete bindings.
- Before submitting, compare each new, revised, or confirmed Claim with its bound passages and source: do they express the same behavior, conditions, and exceptions, and do the bindings locate every passage that needs maintenance? A binding to the read paragraph alone cannot locate separate explanations of orient and outline. Correct the Claim, prose, or bindings within this page-writing step.
- Validation errors identify missing or ambiguous passages and dangling references. Correct the Markdown or sparse metadata and retry the same pending page; completed pages remain intact. Structural validation cannot prove that prose, descriptions, and Claims agree in meaning; verify that agreement against source.`;

/**
 * Shared description of native and MCP page completion.
 */
export const PAGE_SUBMISSION_DESCRIPTION =
  "Complete the assigned page after writing its Markdown. Submit sparse claim decisions (confirmedClaimIds, claims, retractedClaimIds), section metadata (sections, removedSectionIds), and prose links (bindings, removedBindingIds). Include reflectionResults: [{id,claims}] for every pending assigned finding: resulting claim IDs or exact new statements, or claims: [] for a discarded finding. Omitted current records are retained automatically; all resulting connections are validated before completion. Evidence uses repo://<repository-relative-path>, optionally with #Lx-Ly. Correct validation feedback and retry the pending page.";

/**
 * Shared description of on-demand complete page metadata inspection.
 */
export const PAGE_INSPECTION_DESCRIPTION =
  "Return the current pending page's complete Claims, sections, and bindings without opaque evidence versions. Inspect when IDs are needed to revise otherwise-current prose or establish links for a legacy page. Claims and passages requiring evidence review already appear in the assignment.";
