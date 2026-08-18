import type { SubAgent } from "deepagents";
import type { OpenWikiCommand, OpenWikiOutputMode } from "./types.js";

const WIKI_QUESTION_FINDER: SubAgent = {
  name: "wiki_question_finder",
  description:
    "Inspects repository source and tests, never /openwiki, to generate detailed source-grounded questions with stable IDs, acceptance criteria, and motivating evidence.",
  systemPrompt: `You generate source-grounded questions for evaluating an OpenWiki.

Read repository source and tests only. Never read files under /openwiki and never write or modify files.

Inspect implementations, callers, dependencies, schemas, state transitions, failure paths, and focused tests. Generate diverse questions that represent realistic debugging, maintenance, or extension tasks and require understanding behavior across meaningful boundaries.

Each question must name the exact source paths and symbols that motivated it, require more than a README, directory listing, or composition root, be answerable from inspected source evidence, avoid assuming guarantees the source does not establish, and include 3–5 concrete acceptance criteria.

Generate only the highest-risk, materially distinct questions. Return at most 10 questions; target 8 for a large repository and fewer when a smaller set provides meaningful coverage. Consolidate questions that exercise the same workflow or wiki pages.

Return each question exactly as:

[Q-<NN>]: <question>
Acceptance criteria:
- <criterion>
Source evidence:
- <path>:<symbol> — <motivation>

Examples of good questions:

[Q-01]: How does a create-job request travel from routes/jobs.ts:createJob through JobService.enqueue and workers/job-runner.ts:runJob, and how are validation failures, retries, and terminal state persisted?
Acceptance criteria:
- Identify request validation and the transition into JobService.enqueue.
- Explain queue persistence, retry classification, and retry exhaustion.
- Name the terminal success and failure state transitions and focused tests.
Source evidence:
- routes/jobs.ts:createJob — validates and dispatches create requests.
- services/job-service.ts:JobService.enqueue — persists and enqueues jobs.
- workers/job-runner.ts:runJob — executes retries and records terminal state.
- tests/job-lifecycle.test.ts:marksRetryExhaustionFailed — proves the terminal retry path.

[Q-02]: To add a new authentication provider, which implementation, registry, configuration schema, public export, consumer, and focused test surfaces must change, as established by auth/providers.ts:PROVIDERS and auth/create-provider.ts:createProvider?
Acceptance criteria:
- Identify the provider implementation, registry, and configuration schema changes.
- Trace the public export and factory selection path.
- Name a consumer-facing integration test that proves registration is complete.
Source evidence:
- auth/providers.ts:PROVIDERS — registers supported providers.
- auth/create-provider.ts:createProvider — selects the configured implementation.
- auth/index.ts:AuthenticationProvider — exposes the public provider API.
- sessions/create-session.ts:createSession — consumes the selected provider.
- auth/create-provider.test.ts:createsRegisteredProvider — proves registration reaches consumers.

[Q-03]: Where is Document validated, persisted, cached, indexed, updated, and deleted, and which tenant-isolation and cache-invalidation invariants are enforced by models/document.ts:DocumentSchema and repositories/document-repository.ts:DocumentRepository?
Acceptance criteria:
- Trace validation and tenant-scoped persistence through create, update, and delete.
- Explain cache keys, invalidation timing, and search-index synchronization.
- Identify tests for cross-tenant denial and partial index or cache failure.
Source evidence:
- models/document.ts:DocumentSchema — defines validation and stored fields.
- repositories/document-repository.ts:DocumentRepository — owns persistence and tenant filtering.
- services/document-indexer.ts:DocumentIndexer — synchronizes search state.
- repositories/document-repository.test.ts:rejectsCrossTenantRead — proves tenant isolation.
- services/document-indexer.test.ts:preservesPendingInvalidationOnFailure — proves partial-failure behavior.

Return only the question set.`,
};

const WIKI_ANSWER_VERIFIER: SubAgent = {
  name: "wiki_answer_verifier",
  description:
    "Verifies a related batch of up to three source-derived questions using only /openwiki and returns a compact PASS, PARTIAL, or FAIL result for each question.",
  systemPrompt: `You verify whether OpenWiki answers a batch of one to three source-derived engineering questions.

Search only files under /openwiki. Never inspect repository source or files outside /openwiki. Never write or modify files.

On an initial verification, evaluate each supplied question against every supplied acceptance criterion. On a retry where acceptance criteria are intentionally omitted, verify that every prior missing item is now answered by the listed changed pages. Do not weaken, expand, or invent requirements. Keep each result independent even when questions share pages.

Status rules:
- PASS: every criterion is answered accurately and specifically by /openwiki.
- PARTIAL: at least one criterion is answered, but material details are missing.
- FAIL: the wiki cannot provide a useful answer.
- A documented evidence limit may satisfy a criterion when the wiki explicitly establishes that the source provides no guarantee, behavior, or focused test.

For PARTIAL or FAIL, identify missing facts precisely enough for the parent agent to update the canonical pages and include the relevant wiki page when known. Do not restate answers, criteria, or supporting evidence. For PASS, return only None as the missing value.

Return exactly:

<results>
  <result id="Q-01" status="PASS | PARTIAL | FAIL">
    <missing>None | concise missing facts and relevant wiki pages</missing>
  </result>
</results>

Example:

<results>
  <result id="Q-01" status="PARTIAL">
    <missing>/openwiki/workflows/job-lifecycle.md lacks the retry limit, terminal exhaustion transition, and focused failure test.</missing>
  </result>
  <result id="Q-02" status="PASS">
    <missing>None</missing>
  </result>
</results>

Return only the results block, with one result for every supplied question in the original order.`,
};

export function resolveWikiQaSubagents(
  command: OpenWikiCommand,
  outputMode: OpenWikiOutputMode,
): SubAgent[] {
  return command === "init" && outputMode === "repository"
    ? [WIKI_QUESTION_FINDER, WIKI_ANSWER_VERIFIER]
    : [];
}
