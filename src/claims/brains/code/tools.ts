import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import type { DeleteResult } from "deepagents";
import { z } from "zod";
import { ClaimSessionError, EvidenceResourceError } from "../../core/errors.js";
import {
  isGroundedWikiPage,
  normalizeClaimsToolPagePath,
  normalizeWikiToolPagePath,
} from "./paths.js";
import { ClaimSession } from "./session.js";

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
export const ResolveClaimsInputSchema = z
  .object({ pages: z.array(ResolveClaimsPageSchema).min(1) })
  .strict();
/**
 * Runtime validator for `inspect_claims` input.
 */
export const InspectClaimsInputSchema = z
  .object({
    ids: z.array(CanonicalNonEmptyStringSchema).min(1).optional(),
    pages: z.array(CanonicalNonEmptyStringSchema).min(1).optional(),
  })
  .strict()
  .refine(({ ids, pages }) => (ids === undefined) !== (pages === undefined), {
    message: "Pass exactly one of ids or pages",
  });

/**
 * Shared model guidance for Claims mutation tools across agent transports.
 */
export const RESOLVE_CLAIMS_DESCRIPTION =
  "Maintain substantive system truths for one or more wiki pages in one call. Prioritize behavior, responsibilities, architecture and ownership, cross-component relationships, data/control flow, invariants, lifecycle and failure semantics, configuration, security, persistence, operations, and extension seams. Atomic means one coherent falsifiable idea, not one symbol or source line: a claim may connect multiple components and cite multiple evidence resources. Omit low-value facts about symbol existence, paths, signatures, return types, or inheritance unless they materially affect understanding, operation, or safe change. Ensure every material, source-dependent proposition the wiki relies on is represented; completeness takes priority over minimizing Claim count, and distinct truths remain distinct even when the same function or component supports them. Put every affected page in pages; each page's operations are applied atomically. Keep each statement concise—not an excerpt, list, compound summary, or paragraph—and remove semantic duplicates only after establishing coverage. Use confirm when a claim remains true, update to change its statement or evidence, retract when it is obsolete, and add for a new material fact. Normal Markdown edits need no Claims call. Claims currently support repository evidence only; do not invent repository evidence for connector-derived facts, and leave LangSmith-only facts unclaimed. Cite bounded language-agnostic line ranges as repo://path#L10-L24. Use repo://path only when the whole file is the evidence.";

/**
 * Shared model guidance for Claims inspection tools across agent transports.
 */
export const INSPECT_CLAIMS_DESCRIPTION =
  "Inspect material factual propositions without creating a write obligation. Pass ids from one or more OpenWiki Claims read notes for targeted cross-page inspection. Pass pages only as a fallback when complete page claim sets are needed. Pass exactly one selector; results are grouped by owning page.";
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
      description: RESOLVE_CLAIMS_DESCRIPTION,
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
      func: (input) => runClaimsTool(() => resolveClaims(session, input)),
    }),
    new DynamicStructuredTool({
      name: "inspect_claims",
      description: INSPECT_CLAIMS_DESCRIPTION,
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
      func: (input) => runClaimsTool(() => inspectClaims(session, input)),
    }),
  ];
}

/**
 * Applies one validated cross-page Claims mutation through a run session.
 *
 * @param session - Run-scoped authoritative claim state.
 * @param input - Untrusted Claims mutation payload.
 * @returns Per-page mutation results in first-page order.
 */
export async function resolveClaims(
  session: ClaimSession,
  input: unknown,
): Promise<unknown> {
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
  return {
    pages: await Promise.all(
      [...operationsByPage].map(([page, operations]) =>
        session.resolveClaims({ page, operations }),
      ),
    ),
  };
}

/**
 * Reads selected Claims through a run session without creating write debt.
 *
 * @param session - Run-scoped authoritative claim state.
 * @param input - Untrusted Claims selector payload.
 * @returns Selected Claims grouped by owning page.
 */
export function inspectClaims(session: ClaimSession, input: unknown): unknown {
  const parsed = InspectClaimsInputSchema.parse(input);
  return {
    pages: parsed.ids
      ? session.inspectClaimsByIds(parsed.ids)
      : [...new Set((parsed.pages ?? []).map(normalizeClaimsToolPagePath))].map(
          (page) => {
            return { page, claims: session.inspectClaims(page) };
          },
        ),
  };
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
async function runClaimsTool(operation: () => unknown): Promise<string> {
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
