import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { cleanupPlanFile } from "../src/agent/utils.ts";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("cleanupPlanFile", () => {
  test("removes the repository-mode plan file", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "openwiki-plan-repo-"));
    await mkdir(path.join(cwd, "openwiki"), { recursive: true });
    const planPath = path.join(cwd, "openwiki", "_plan.md");
    await writeFile(planPath, "# plan\n");

    await cleanupPlanFile(cwd, "repository");

    expect(await fileExists(planPath)).toBe(false);
  });

  test("removes the local-wiki-mode plan file", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "openwiki-plan-local-"));
    const planPath = path.join(cwd, "_plan.md");
    await writeFile(planPath, "# plan\n");

    await cleanupPlanFile(cwd, "local-wiki");

    expect(await fileExists(planPath)).toBe(false);
  });

  test("does not throw when the plan file is missing", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "openwiki-plan-none-"));

    await expect(cleanupPlanFile(cwd, "repository")).resolves.toBeUndefined();
    await expect(cleanupPlanFile(cwd, "local-wiki")).resolves.toBeUndefined();
  });
});
