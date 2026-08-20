import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import type { DeleteResult } from "deepagents";
import { z } from "zod";
import { ClaimSessionError, EvidenceResourceError } from "../../core/errors.js";
import { CLAIMS_SUBSTANCE_GUIDANCE } from "../../guidance.js";
import type { ClaimOperation } from "../../core/types.js";
import {
  isGroundedWikiPage,
  normalizeClaimsToolPagePath,
  normalizeWikiToolPagePath,
} from "./paths.js";
import { ClaimSession } from "./session.js";
import type { ResolveClaimsResult } from "./types.js";

/**
 * Runtime validator for canonical non-empty identity strings.
 */
const CanonicalNonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), {
    message: "Must not contain surrounding whitespace",
  });
/**
 * Runtime validator for concise, trimmed, non-empty claim prose.
 */
const ClaimStatementSchema = z.string().trim().min(1);

/**
 * Runtime validator for an agent-proposed evidence identity.
 */
const ProposedEvidenceSchema = z
  .object({ resource: CanonicalNonEmptyStringSchema })
  .strict();
/**
 * Runtime validator for a non-empty proposed evidence set.
 */
const EvidenceArraySchema = z.array(ProposedEvidenceSchema).min(1);

/**
 * Runtime validator for one compact claim operation.
 */
const ClaimOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("add"),
      statement: ClaimStatementSchema,
      evidence: EvidenceArraySchema,
    })
    .strict(),
  z
    .object({ op: z.literal("confirm"), id: CanonicalNonEmptyStringSchema })
    .strict(),
  z
    .object({
      op: z.literal("update"),
      id: CanonicalNonEmptyStringSchema,
      statement: ClaimStatementSchema.optional(),
      evidence: EvidenceArraySchema.optional(),
    })
    .strict()
    .refine(
      (operation) =>
        operation.statement !== undefined || operation.evidence !== undefined,
      { message: "An update requires statement or evidence" },
    ),
  z
    .object({ op: z.literal("retract"), id: CanonicalNonEmptyStringSchema })
    .strict(),
]);

/**
 * Runtime validator for one page-local `resolve_claims` mutation batch.
 */
const ResolveClaimsPageSchema = z
  .object({
    page: CanonicalNonEmptyStringSchema,
    operations: z.array(ClaimOperationSchema).min(1),
  })
  .strict();
/**
 * Runtime validator for one cross-page `resolve_claims` call.
 */
const ResolveClaimsInputSchema = z
  .object({ pages: z.array(ResolveClaimsPageSchema).min(1) })
  .strict();
/**
 * Runtime validator for `inspect_claims` input.
 */
const InspectClaimsInputSchema = z
  .object({
    ids: z.array(CanonicalNonEmptyStringSchema).min(1).optional(),
    pages: z.array(CanonicalNonEmptyStringSchema).min(1).optional(),
  })
  .strict()
  .refine(({ ids, pages }) => (ids === undefined) !== (pages === undefined), {
    message: "Pass exactly one of ids or pages",
  });
/**
 * Runtime validator for the DeepAgents-compatible `delete_file` input.
 */
const DeleteFileInputSchema = z
  .object({ file_path: CanonicalNonEmptyStringSchema })
  .strict();

/**
 * Guarded backend capability required by the Claims page-deletion tool.
 */
export interface ClaimsDeletionBackend {
  /**
   * Deletes one canonical generated page.
   *
   * @param filePath - Canonical virtual page path.
   * @returns Backend-confirmed deletion result.
   */
  delete(filePath: string): Promise<DeleteResult>;
}

/**
 * Creates compact batched Claims tools for one run.
 *
 * @param session - Run-scoped authoritative claim state.
 * @returns Mutation and inspection tools bound to the session.
 */
export function createClaimsTools(
  session: ClaimSession,
): StructuredToolInterface[] {
  return [
    new DynamicStructuredTool({
      name: "resolve_claims",
      description: `${CLAIMS_SUBSTANCE_GUIDANCE}

Maintain those Claims for one or more wiki pages in one call. Put every affected page in pages: a whole authoring or repair phase is one call, and calling this once per page in a loop is always wrong. Each page's operations apply atomically and each page succeeds or fails on its own - successful pages come back under pages, failures under failed with their own error - so retry only the failures and never replay a page that already succeeded. Each statement is one concise proposition, not an excerpt, list, compound summary, or paragraph. Use add for a new material fact, confirm when a claim remains true, update to change its statement or evidence, and retract when it is obsolete. Normal Markdown edits need no Claims call. Claims support repository evidence only: cite the narrowest sufficient span as repo://path#L10-L24, or repo://path when the whole file is the evidence. Do not invent repository evidence for connector-derived facts, and leave LangSmith-only facts unclaimed.`,
      schema: {
        type: "object",
        properties: {
          pages: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                page: { type: "string", minLength: 1 },
                operations: {
                  type: "array",
                  minItems: 1,
                  items: {
                    oneOf: [
                      {
                        type: "object",
                        properties: {
                          op: { const: "add" },
                          statement: {
                            type: "string",
                            minLength: 1,
                          },
                          evidence: evidenceArraySchema(),
                        },
                        required: ["op", "statement", "evidence"],
                        additionalProperties: false,
                      },
                      {
                        type: "object",
                        properties: {
                          op: { const: "confirm" },
                          id: { type: "string", minLength: 1 },
                        },
                        required: ["op", "id"],
                        additionalProperties: false,
                      },
                      {
                        type: "object",
                        properties: {
                          op: { const: "update" },
                          id: { type: "string", minLength: 1 },
                          statement: {
                            type: "string",
                            minLength: 1,
                          },
                          evidence: evidenceArraySchema(),
                        },
                        required: ["op", "id"],
                        anyOf: [
                          { required: ["statement"] },
                          { required: ["evidence"] },
                        ],
                        additionalProperties: false,
                      },
                      {
                        type: "object",
                        properties: {
                          op: { const: "retract" },
                          id: { type: "string", minLength: 1 },
                        },
                        required: ["op", "id"],
                        additionalProperties: false,
                      },
                    ],
                  },
                },
              },
              required: ["page", "operations"],
              additionalProperties: false,
            },
          },
        },
        required: ["pages"],
        additionalProperties: false,
      } as const,
      func: (input) =>
        runClaimsTool(async () => {
          const parsed = ResolveClaimsInputSchema.parse(input);
          const operationsByPage = new Map<
            string,
            (typeof parsed.pages)[number]["operations"]
          >();
          for (const pageInput of parsed.pages) {
            const page = normalizeClaimsToolPagePath(pageInput.page);
            const operations = operationsByPage.get(page);
            if (operations) {
              operations.push(...pageInput.operations);
            } else {
              operationsByPage.set(page, [...pageInput.operations]);
            }
          }
          return resolvePagesIndependently(session, [...operationsByPage]);
        }),
    }),
    new DynamicStructuredTool({
      name: "inspect_claims",
      description:
        "Inspect material factual propositions without creating a write obligation. Pass ids from one or more OpenWiki Claims read notes for targeted cross-page inspection. Pass pages only as a fallback when complete page claim sets are needed. Pass exactly one selector; results are grouped by owning page.",
      schema: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          pages: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
        },
        additionalProperties: false,
      } as const,
      func: (input) =>
        runClaimsTool(() => {
          const parsed = InspectClaimsInputSchema.parse(input);
          return Promise.resolve({
            pages: parsed.ids
              ? session.inspectClaimsByIds(parsed.ids)
              : [
                  ...new Set(
                    (parsed.pages ?? []).map(normalizeClaimsToolPagePath),
                  ),
                ].map((page) => {
                  return { page, claims: session.inspectClaims(page) };
                }),
          });
        }),
    }),
  ];
}

/**
 * Creates the repository page-deletion tool missing from DeepAgents 1.12.
 *
 * The tool records a successful Markdown deletion in the Claims session so
 * finalization removes the owning sidecar without model-managed retractions.
 *
 * @param session - Run-scoped authoritative claim state.
 * @param backend - Guarded OpenWiki filesystem backend.
 * @returns Model-facing page deletion tool.
 */
export function createClaimsDeleteFileTool(
  session: ClaimSession,
  backend: ClaimsDeletionBackend,
): StructuredToolInterface {
  return new DynamicStructuredTool({
    name: "delete_file",
    description:
      "Delete one generated wiki page. Its Claims sidecar is removed automatically after a successful deletion.",
    schema: {
      type: "object",
      properties: {
        file_path: { type: "string", minLength: 1 },
      },
      required: ["file_path"],
      additionalProperties: false,
    } as const,
    func: (input) =>
      runClaimsTool(async () => {
        const parsed = DeleteFileInputSchema.parse(input);
        const page = normalizeWikiToolPagePath(parsed.file_path);
        const result = await backend.delete(page);
        if (result.error) {
          return { error: result.error };
        }
        if (!result.path) {
          throw new Error(
            `Deletion backend did not confirm the deleted path: ${page}`,
          );
        }
        if (isGroundedWikiPage(page)) {
          await session.recordDeletion(page);
        }
        return { deleted: page };
      }),
  });
}

/**
 * Executes a model-facing Claims operation with recoverable input failures.
 *
 * Non-fallback evidence, filesystem, and unexpected failures are intentionally
 * rethrown so they cannot be mistaken for agent input errors.
 *
 * @param operation - Parsed Claims operation to execute.
 * @returns Compact JSON for either success or a retryable input failure.
 */
/**
 * Pages a single `resolve_claims` call may resolve at once.
 *
 * Every page's operations resolve their evidence against the repository, so an
 * unbounded fan-out over a large monorepo's worth of pages puts one resolver
 * request in flight per page. Eight keeps a phase-sized call - the batching the
 * tool description asks for - from becoming a thundering herd, while still
 * finishing a 60-page phase in eight rounds rather than sixty.
 */
const RESOLVE_CLAIMS_PAGE_CONCURRENCY = 8;

/**
 * Resolves each page independently, so one page's failure is one page's failure.
 *
 * `Promise.all` rejected the whole call when any single page did, and
 * `runClaimsTool` then turned that into one batch-wide `{error, retryable}`.
 * The pages that had already succeeded were invisible in that response while
 * their mutations had in fact applied, so the model could neither tell which
 * page was at fault nor safely retry: replaying the batch duplicated every add
 * that worked the first time.
 *
 * The coordinator's answer, observed in a graded run, was to stop batching -
 * `for (const p of payloads) await resolveClaims({pages: [p]})`, one call per
 * page, 108 calls where 8 would do, with a hand-rolled evidence filter in the
 * catch. It was not wrong to do that: per-page calls were the only way to learn
 * which page failed. Reporting per page removes the reason.
 *
 * Per-page atomicity is unchanged and comes from the session, which serializes
 * each page's mutations and swaps its claim set in one step.
 *
 * @param session - Run-scoped authoritative claim state.
 * @param entries - Deduplicated page and operation pairs from one call.
 * @returns Successful pages under `pages`, and any failures under `failed`.
 */
export async function resolvePagesIndependently(
  session: ClaimSession,
  entries: readonly [string, ClaimOperation[]][],
): Promise<{
  pages: ResolveClaimsResult[];
  failed?: { page: string; error: string; retryable: boolean }[];
}> {
  const pages: ResolveClaimsResult[] = [];
  const failed: { page: string; error: string; retryable: boolean }[] = [];
  for (
    let index = 0;
    index < entries.length;
    index += RESOLVE_CLAIMS_PAGE_CONCURRENCY
  ) {
    const window = entries.slice(
      index,
      index + RESOLVE_CLAIMS_PAGE_CONCURRENCY,
    );
    const settled = await Promise.allSettled(
      window.map(([page, operations]) =>
        session.resolveClaims({ page, operations }),
      ),
    );
    for (const [offset, outcome] of settled.entries()) {
      if (outcome.status === "fulfilled") {
        pages.push(outcome.value);
        continue;
      }
      if (!isRecoverableClaimsToolError(outcome.reason)) {
        // An operational failure - a missing grammar, an unreadable tree - is
        // not a result to report, and rethrowing is how it stays visible rather
        // than becoming quietly ungrounded pages. But throwing discards every
        // page in `pages`, and those pages' mutations HAVE applied: the session
        // swapped their claim sets before this one failed. Reporting a total
        // failure over applied state is the same lie the batch-wide error told.
        //
        // So it only throws when nothing succeeded, which is the shape a real
        // operational failure has anyway - a broken resolver fails every page,
        // not the third one. A partial failure is reported, marked not
        // retryable so the model does not replay it expecting a different
        // answer.
        if (pages.length === 0) {
          throw outcome.reason;
        }
        failed.push({
          page: window[offset][0],
          error:
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
          retryable: false,
        });
        continue;
      }
      failed.push({
        page: window[offset][0],
        error: formatRecoverableClaimsToolError(outcome.reason),
        retryable: true,
      });
    }
  }
  return failed.length > 0 ? { pages, failed } : { pages };
}

async function runClaimsTool(
  operation: () => Promise<unknown>,
): Promise<string> {
  try {
    return JSON.stringify(await operation());
  } catch (error) {
    if (!isRecoverableClaimsToolError(error)) {
      throw error;
    }
    return JSON.stringify({
      error: formatRecoverableClaimsToolError(error),
      retryable: true,
    });
  }
}

/**
 * Identifies deterministic failures the model can correct in another call.
 *
 * @param error - Unknown Claims tool failure.
 * @returns Whether the failure is safe to return to the model.
 */
function isRecoverableClaimsToolError(
  error: unknown,
): error is ClaimSessionError | EvidenceResourceError | z.ZodError {
  return (
    error instanceof ClaimSessionError ||
    error instanceof EvidenceResourceError ||
    error instanceof z.ZodError
  );
}

/**
 * Formats one recoverable Claims failure as concise retry guidance.
 *
 * @param error - Validated recoverable tool failure.
 * @returns Human-readable correction guidance.
 */
function formatRecoverableClaimsToolError(
  error: ClaimSessionError | EvidenceResourceError | z.ZodError,
): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "input";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
  }
  return error.message;
}

/**
 * Creates the JSON Schema fragment for one non-empty evidence set.
 *
 * @returns Strict model-facing evidence array schema.
 */
function evidenceArraySchema() {
  return {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      properties: { resource: { type: "string", minLength: 1 } },
      required: ["resource"],
      additionalProperties: false,
    },
  } as const;
}
