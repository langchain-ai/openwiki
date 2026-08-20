import { z } from "zod";

const HOST_ID_PATTERN = /^[a-z0-9-]{1,64}$/u;

/**
 * Lifecycle modes supported by host-authored repository runs.
 */
export type HostRunMode = "init" | "update";

/**
 * Stable names in the complete V1 host lifecycle tool set.
 */
export type ProtocolToolName = "openwiki_begin" | "openwiki_finish";

/**
 * Validated request accepted by `openwiki_begin`.
 */
export interface BeginRequest {
  /**
   * Absolute path inside the Git repository to document.
   */
  root: string;

  /**
   * Lifecycle mode selected for the run.
   */
  mode: HostRunMode;

  /**
   * Optional requested BCP-47 wiki language.
   *
   * @default undefined - inherit the prior language or use English.
   */
  language?: string;
}

/**
 * Validated run selector accepted by `openwiki_finish`.
 */
export interface RunRequest {
  /**
   * Opaque identifier returned by the matching begin request.
   */
  runId: string;
}

/**
 * Validated input accepted by `openwiki_begin`.
 */
export const BeginInput: z.ZodType<BeginRequest> = z
  .object({
    root: z.string().trim().min(1),
    mode: z.enum(["init", "update"]),
    language: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * Validated run selector accepted by `openwiki_finish`.
 */
export const RunInput: z.ZodType<RunRequest> = z
  .object({
    runId: z.string().uuid(),
  })
  .strict();

/**
 * Validates the bounded identifier used for host metadata and provenance.
 *
 * @param value - Candidate host identifier.
 * @returns Whether the identifier is safe and protocol-compatible.
 */
export function isValidHostId(value: string): boolean {
  return HOST_ID_PATTERN.test(value);
}

/**
 * Transport-neutral tool exposed by the host lifecycle core.
 */
export interface ProtocolTool {
  /**
   * Stable transport-visible tool name.
   */
  name: ProtocolToolName;

  /**
   * Human-readable model guidance for the tool.
   */
  description: string;

  /**
   * Runtime input validator and JSON Schema source.
   */
  schema: z.ZodType;

  /**
   * Executes the validated transport-neutral operation.
   *
   * @param input - Untrusted candidate input to validate at the boundary.
   * @returns Structured JSON-compatible operation result.
   */
  handle(input: unknown): Promise<unknown>;
}
