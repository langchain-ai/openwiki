import { z } from "zod";
import { REFLECTION_ID_PATTERN } from "../memory/reflection-types.js";

/**
 * Non-empty planner text, normalized before reaching the lifecycle.
 */
const PlanText = z.string().trim().min(1);

/**
 * Captured reflection identity shared by native and MCP authoring schemas.
 */
export const ReflectionIdInput = PlanText.regex(REFLECTION_ID_PATTERN);

/**
 * One final factual page and the pending discoveries assigned to its author.
 */
export const PlanPageInput = z
  .object({
    path: PlanText,
    title: PlanText,
    purpose: PlanText,
    seedPaths: z.array(PlanText).optional(),
    relatedPages: z.array(PlanText).optional(),
    instructions: z.array(PlanText).optional(),
    reflectionIds: z.array(ReflectionIdInput).optional(),
  })
  .strict();

/**
 * Complete native and MCP planning contract; discarded findings need no page edits.
 */
export const RepositoryPlanInput = z
  .object({
    pages: z.array(PlanPageInput),
    deletePages: z.array(PlanText).optional(),
    discardedReflectionIds: z.array(ReflectionIdInput).optional(),
  })
  .strict();
