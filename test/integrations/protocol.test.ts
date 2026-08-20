import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BeginInput, RunInput } from "../../src/integrations/core/protocol.ts";
import {
  type BeginResult,
  HostSessionManager,
} from "../../src/integrations/core/session-manager.ts";

const temporaryRoots: string[] = [];

/**
 * Creates an isolated repository root for a protocol test.
 *
 * @returns Absolute temporary repository path.
 */
async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-protocol-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("host lifecycle protocol", () => {
  test("validates strict begin and finish inputs", () => {
    expect(
      BeginInput.parse({
        root: "/tmp/repository",
        mode: "init",
        language: " fr ",
      }),
    ).toEqual({
      root: "/tmp/repository",
      mode: "init",
      language: "fr",
    });
    expect(() => BeginInput.parse({ mode: "init" })).toThrow();
    expect(() => BeginInput.parse({ mode: "chat" })).toThrow();
    expect(() => BeginInput.parse({ mode: "init", extra: true })).toThrow();
    expect(() => RunInput.parse({ runId: "not-a-uuid" })).toThrow();
    expect(() =>
      RunInput.parse({
        runId: "123e4567-e89b-42d3-a456-426614174000",
        extra: true,
      }),
    ).toThrow();
  });

  test("exposes exactly the two V1 lifecycle tools", async () => {
    const root = await createRepository();
    const manager = HostSessionManager.create({ host: "codex" });
    const tools = manager.tools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "openwiki_begin",
      "openwiki_finish",
    ]);
    expect(tools).toHaveLength(2);
    expect(
      tools.some((tool) => /read|write|edit|delete/u.test(tool.name)),
    ).toBe(false);

    const begin = tools.find((tool) => tool.name === "openwiki_begin");
    const finish = tools.find((tool) => tool.name === "openwiki_finish");
    expect(begin).toBeDefined();
    expect(finish).toBeDefined();
    await expect(
      begin?.handle({ root, mode: "init", extra: true }),
    ).rejects.toThrow();

    const started = (await begin?.handle({
      root,
      mode: "init",
    })) as BeginResult;
    expect(started.root).toBe(await realpath(root));
    await expect(finish?.handle({ runId: started.runId })).resolves.toEqual({
      status: "complete",
    });
  });
});
