import { z } from "zod";
import { PageReconciliationInput } from "../../generation/page-input.js";
import { RepositoryPlanInput } from "../../generation/plan-input.js";
export { PlanPageInput } from "../../generation/plan-input.js";
import { ReflectionProposalSchema } from "../../memory/reflection-types.js";
export { ProposedPageClaimInput } from "../../generation/page-input.js";

/**
 * Bounded host identifier suitable for persisted provenance.
 */
const HOST_ID_PATTERN = /^[a-z0-9-]{1,64}$/u;

/**
 * Non-empty protocol text with incidental surrounding whitespace removed.
 */
const CanonicalString = z.string().trim().min(1);

/**
 * Lifecycle modes supported by host-authored repository runs.
 */
export type HostRunMode = "init" | "update";

/**
 * Supported repository memory and generation MCP tool names.
 */
export type ProtocolToolName =
  | "openwiki_orient"
  | "openwiki_outline"
  | "openwiki_read"
  | "openwiki_reflect"
  | "openwiki_begin"
  | "openwiki_submit_plan"
  | "openwiki_next_page"
  | "openwiki_inspect_page_claims"
  | "openwiki_submit_page"
  | "openwiki_finish";

/**
 * Fixed repository-wide orientation request, independent of generation runs.
 */
export const OrientInput = z
  .object({
    root: CanonicalString.describe(
      "Absolute Git repository root containing openwiki/.",
    ),
  })
  .strict();

/**
 * Page navigation request using the wiki-relative path returned by orient.
 */
export const OutlineInput = OrientInput.extend({
  page: CanonicalString.describe(
    "Wiki-relative Markdown path, for example concepts/retries.md.",
  ),
}).strict();

/**
 * Selective reading request; omitted selectors mean the complete page.
 */
export const ReadInput = OutlineInput.extend({
  sections: z
    .array(CanonicalString)
    .min(1)
    .describe(
      "Stable section IDs from outline. Parents include descendants; omit to read the whole page.",
    )
    .optional(),
}).strict();

/**
 * Creates one pending repository discovery with OpenWiki-owned evidence versions.
 */
export const ReflectInput = OrientInput.extend(
  ReflectionProposalSchema.shape,
).strict();

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
   * Optional requested documentation language, as a BCP-47 code (for example
   * `ko`, `zh-CN`, `pt-BR`) rather than an English language name. An
   * unrecognized value fails the call with `invalid_input` and starts no run,
   * so a rejected request leaves nothing to clean up and can simply be retried
   * with a real code. Omit it to keep the wiki's existing language.
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
    language: CanonicalString.describe(
      'BCP-47 code, e.g. "ko" (not "Korean").',
    ).optional(),
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
 * Strict MCP schema for `openwiki_submit_plan`.
 */
export const SubmitPlanInput = RepositoryPlanInput.extend({
  runId: z.string().uuid(),
}).strict();

/**
 * Strict MCP schema for `openwiki_next_page`.
 */
export const NextPageInput = RunInput;

/**
 * Strict MCP schema for inspecting the current pending page's Claims on demand.
 */
export const InspectPageClaimsInput = z
  .object({
    runId: z.string().uuid(),
    jobId: z.string().uuid(),
  })
  .strict();

/**
 * Strict MCP schema for `openwiki_submit_page`.
 */
export const SubmitPageInput = PageReconciliationInput.extend({
  runId: z.string().uuid(),
  jobId: z.string().uuid(),
}).strict();

/**
 * Validated plan submission payload.
 */
export type SubmitPlanRequest = z.infer<typeof SubmitPlanInput>;

/**
 * Validated next-page request payload.
 */
export type NextPageRequest = z.infer<typeof NextPageInput>;

/**
 * Validated request for the current pending page's complete Claims and prose metadata.
 */
export type InspectPageClaimsRequest = z.infer<typeof InspectPageClaimsInput>;

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
 * Transport-neutral definition of one OpenWiki operation.
 */
export interface ProtocolTool {
  /**
   * Canonical MCP tool name.
   */
  name: ProtocolToolName;

  /**
   * Model-facing description of the operation.
   */
  description: string;

  /**
   * Strict runtime schema for the tool input.
   */
  schema: z.ZodType;

  /**
   * Validates and executes one operation.
   *
   * @param input - Untrusted transport input.
   * @returns The structured operation result.
   */
  handle(input: unknown): Promise<unknown>;
}
