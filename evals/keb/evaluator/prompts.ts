import type { ActiveTruthFact, ObsoleteFactTarget } from "../core/types.js";

/**
 * Version of the evaluator prompts and logic. Bump this on any change that could
 * alter verdicts, so results carry the exact evaluation contract they were
 * produced under.
 */
export const PROMPT_VERSION = "keb-eval-1";

/**
 * Shared preamble for every pass. Establishes blind evaluation (the evaluator is
 * never told which system produced the wiki), the read-only sandbox, and the
 * expectation of strict, evidence-cited judgments.
 */
const SHARED_SYSTEM = `You are a strict, impartial documentation evaluator.

You are given read-only access to an evaluation workspace through filesystem
tools (ls, read_file, glob, grep). The generated wiki is under "/artifact". You
do not know which system produced this wiki; judge only what is written.

Rules:
- Read the wiki before judging. Use glob("artifact/**/*.md") and grep to locate
  content.
- Cite the workspace-relative path of every file you rely on (paths under the
  wiki start with "artifact/").
- Judge only what the wiki actually states, not what you assume it means.
- Be strict: partial or hedged coverage is not full coverage.
- Return your answer only through the structured response format.`;

/**
 * System prompt for the coverage pass.
 */
export const COVERAGE_SYSTEM = SHARED_SYSTEM;

/**
 * System prompt for the forgetting pass.
 */
export const FORGETTING_SYSTEM = SHARED_SYSTEM;

/**
 * System prompt for the precision pass.
 */
export const PRECISION_SYSTEM = SHARED_SYSTEM;

/**
 * Build the coverage task: given the facts that are true now, decide for each
 * whether the wiki states it correctly, partially, not at all, or contradicts
 * it. Exactly one verdict per fact id.
 *
 * @param activeFacts - The facts true at this checkpoint.
 *
 * @returns The task prompt.
 */
export function coveragePrompt(activeFacts: ActiveTruthFact[]): string {
  const facts = activeFacts.map((fact) => ({
    factId: fact.factId,
    statement: fact.statement,
  }));

  return `For each fact below, search the wiki and decide whether the wiki
states it. Return exactly one evaluation per factId.

Verdicts:
- "correct": the wiki states the fact accurately.
- "partial": the wiki gestures at the fact but is incomplete or imprecise.
- "missing": the wiki does not state the fact.
- "contradicted": the wiki states something that conflicts with the fact.

Facts (JSON):
${JSON.stringify(facts, null, 2)}`;
}

/**
 * Build the forgetting task: given statements that used to be true and are now
 * obsolete, decide for each whether the wiki still asserts it. Exactly one
 * verdict per fact id.
 *
 * @param obsoleteFacts - The obsolete fact versions that should no longer appear.
 *
 * @returns The task prompt.
 */
export function forgettingPrompt(obsoleteFacts: ObsoleteFactTarget[]): string {
  const targets = obsoleteFacts.map((target) => ({
    factVersionId: target.factVersionId,
    obsoleteStatement: target.obsoleteStatement,
  }));

  return `Each statement below was true earlier in this project's history but is
now obsolete. For each, search the wiki and decide whether the wiki still
asserts that obsolete statement. Return exactly one evaluation per
factVersionId.

Verdicts:
- "forgotten": the wiki no longer asserts the obsolete statement.
- "lingering": the wiki still asserts it (cite where).

Obsolete fact versions (JSON):
${JSON.stringify(targets, null, 2)}`;
}

/**
 * Build the precision task: extract every unique material assertion the wiki
 * makes and judge each against the active Truth Ledger materialized at
 * `/truth-ledger.json`. This pass judges the wiki against ground truth; it does
 * not ask whether the wiki substantiates itself, and it never inspects source
 * code.
 *
 * @returns The task prompt.
 */
export function precisionPrompt(): string {
  return `Read every document under "/artifact" and extract each unique,
material assertion the wiki makes (a concrete, checkable claim about behavior,
structure, configuration, or APIs; ignore vague or purely navigational text).
Deduplicate assertions that say the same thing.

Read the active Truth Ledger at "/truth-ledger.json". It lists the facts that
are true at this checkpoint, each with a factId and statement. Judge every
unique material assertion against that ledger:

- "supported": the ledger entails or is consistent with the assertion. Set
  supportingFactIds to the factId (or factIds) that support it.
- "unsupported": the ledger contradicts the assertion, or nothing in the ledger
  supports it. Leave supportingFactIds empty.

Evaluate ALL unique material assertions; do not sample. You may work through the
wiki in batches across files, but every unique material assertion must receive
exactly one verdict. Cite each assertion's location as a workspace-relative path
(it will start with "artifact/").`;
}
