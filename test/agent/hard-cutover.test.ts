import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

const REMOVED_PATHS = [
  "src/agent/review-subagents.ts",
  "src/agent/skeleton-critic.ts",
  "src/agent/wiki-qa-subagents.ts",
  "src/claims/brains/code/integration.ts",
  "src/claims/brains/code/middleware.ts",
  "src/claims/brains/code/tools.ts",
  "integrations/openwiki/references/init.md",
  "integrations/openwiki/references/update.md",
  "integrations/openwiki/references/methodology.md",
  "integrations/openwiki/references/reviewers.md",
  "integrations/openwiki/references/security.md",
  "test/agent/review-subagents.test.ts",
  "test/claims/brains/code/middleware.test.ts",
  "test/claims/brains/code/tools.test.ts",
] as const;

describe("repository-generation hard cutover", () => {
  test.each(REMOVED_PATHS)("keeps %s absent", async (relativePath) => {
    await expect(
      access(path.join(process.cwd(), relativePath)),
    ).rejects.toThrow(/ENOENT/u);
  });
});
