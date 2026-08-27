import { z } from "zod";

const HOST_ID_PATTERN = /^[a-z0-9-]{1,64}$/u;
const CanonicalString = z.string().trim().min(1);

/**
 * Lifecycle modes supported by host-authored repository runs.
 */
export type HostRunMode = "init" | "update";

/**
 * The complete 0.4 repository-generation MCP tool set.
 */
export type ProtocolToolName =
  | "openwiki_begin"
  | "openwiki_submit_plan"
  | "openwiki_next_page"
  | "openwiki_submit_page"
  | "openwiki_finish";

/**
 * Validated host request to start or resume a repository run.
 */
export interface BeginRequest {
  /**
   * User-supplied path resolved to an absolute Git repository root.
   */
  root: string;

  /**
   * Repository generation command to start or resume.
   */
  mode: HostRunMode;

  /**
   * Optional requested documentation language.
   */
  language?: string;

  /**
   * Whether update no-op detection must be bypassed.
   */
  force?: boolean;
}

/**
 * Validated request addressing one active durable run.
 */
export interface RunRequest {
  /**
   * Stable UUID returned by `openwiki_begin` for the active run.
   */
  runId: string;
}

/**
 * Strict MCP schema for `openwiki_begin`.
 */
export const BeginInput: z.ZodType<BeginRequest> = z
  .object({
    root: CanonicalString,
    mode: z.enum(["init", "update"]),
    language: CanonicalString.optional(),
    force: z.boolean().optional(),
  })
  .strict();

/**
 * Strict run-identity schema shared by next/finish operations.
 */
export const RunInput: z.ZodType<RunRequest> = z
  .object({
    runId: z.string().uuid(),
  })
  .strict();

/**
 * Strict model/host proposal for one final factual page.
 */
export const PlanPageInput = z
  .object({
    path: CanonicalString,
    title: CanonicalString,
    purpose: CanonicalString,
    seedPaths: z.array(CanonicalString).optional(),
    relatedPages: z.array(CanonicalString).optional(),
    instructions: z.array(CanonicalString).optional(),
  })
  .strict();

/**
 * Strict MCP schema for `openwiki_submit_plan`.
 */
export const SubmitPlanInput = z
  .object({
    runId: z.string().uuid(),
    // Empty is valid for an update that has no documentation page work or only
    // planned deletions. Init validation still requires quickstart downstream.
    pages: z.array(PlanPageInput),
    deletePages: z.array(CanonicalString).optional(),
  })
  .strict();

/**
 * Strict MCP schema for `openwiki_next_page`.
 */
export const NextPageInput = RunInput;

/**
 * Strict proposed material Claim with code-owned version omitted.
 */
export const ProposedPageClaimInput = z
  .object({
    id: CanonicalString.optional(),
    statement: CanonicalString,
    evidence: z.array(z.object({ resource: CanonicalString }).strict()).min(1),
  })
  .strict();

/**
 * Strict MCP schema for `openwiki_submit_page`.
 */
export const SubmitPageInput = z
  .object({
    runId: z.string().uuid(),
    jobId: z.string().uuid(),
    // Every PageJob is a factual concept page. Structural index pages are
    // deterministic and never become jobs, so a completed page must establish
    // at least one material repository-grounded Claim.
    claims: z.array(ProposedPageClaimInput).min(1),
  })
  .strict();

/**
 * Validated plan submission payload.
 */
export type SubmitPlanRequest = z.infer<typeof SubmitPlanInput>;

/**
 * Validated next-page request payload.
 */
export type NextPageRequest = z.infer<typeof NextPageInput>;

/**
 * Validated page completion payload.
 */
export type SubmitPageRequest = z.infer<typeof SubmitPageInput>;

/**
 * Returns whether a host/producer identifier is safe for protocol metadata.
 *
 * @param value - Candidate host or producer identifier.
 * @returns Whether the identifier is canonical and bounded.
 */
export function isValidHostId(value: string): boolean {
  return HOST_ID_PATTERN.test(value);
}

/**
 * One of the complete five MCP tools exposed by OpenWiki 0.4.
 */
export interface ProtocolTool {
  /**
   * Canonical MCP lifecycle tool name.
   */
  name: ProtocolToolName;

  /**
   * Model-facing description of the lifecycle operation.
   */
  description: string;

  /**
   * Strict runtime schema for the tool input.
   */
  schema: z.ZodType;

  /**
   * Validates and executes one lifecycle operation.
   *
   * @param input - Untrusted transport input.
   * @returns The structured lifecycle result.
   */
  handle(input: unknown): Promise<unknown>;
}
