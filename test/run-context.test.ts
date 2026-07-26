import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createRunContext } from "../src/agent/utils.ts";

describe("createRunContext output language", () => {
  test("propagates a selected language and leaves it unset by default", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-run-context-"));

    try {
      await expect(
        createRunContext("chat", cwd, "repository", "zh-CN"),
      ).resolves.toMatchObject({
        language: "zh-CN",
      });
      expect(
        await createRunContext("chat", cwd, "repository"),
      ).not.toHaveProperty("language");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
