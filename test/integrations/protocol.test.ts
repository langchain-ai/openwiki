import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BeginInput,
  InspectClaimsInput,
  ResolveClaimsInput,
  RunInput,
} from "../../src/integrations/core/protocol.ts";
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
  test("validates strict lifecycle and Claims inputs", () => {
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
    expect(() =>
      InspectClaimsInput.parse({
        runId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    ).toThrow();
    expect(() =>
      InspectClaimsInput.parse({
        runId: "123e4567-e89b-42d3-a456-426614174000",
        ids: ["claim_1"],
        pages: ["openwiki/page.md"],
      }),
    ).toThrow();
    expect(() =>
      ResolveClaimsInput.parse({
        runId: "123e4567-e89b-42d3-a456-426614174000",
        pages: [],
      }),
    ).toThrow();
  });

  test("exposes lifecycle and Claims tools through one active run", async () => {
    const root = await createRepository();
    await writeFile(path.join(root, "README.md"), "# Repository\n", "utf8");
    const manager = HostSessionManager.create({ host: "codex" });
    const tools = manager.tools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "openwiki_begin",
      "openwiki_inspect_claims",
      "openwiki_resolve_claims",
      "openwiki_finish",
    ]);
    expect(tools).toHaveLength(4);
    expect(
      tools.some((tool) => /read|write|edit|delete/u.test(tool.name)),
    ).toBe(false);

    const begin = tools.find((tool) => tool.name === "openwiki_begin");
    const inspect = tools.find(
      (tool) => tool.name === "openwiki_inspect_claims",
    );
    const resolve = tools.find(
      (tool) => tool.name === "openwiki_resolve_claims",
    );
    const finish = tools.find((tool) => tool.name === "openwiki_finish");
    expect(begin).toBeDefined();
    expect(inspect).toBeDefined();
    expect(resolve).toBeDefined();
    expect(finish).toBeDefined();
    await expect(
      begin?.handle({ root, mode: "init", extra: true }),
    ).rejects.toThrow();

    const started = (await begin?.handle({
      root,
      mode: "init",
    })) as BeginResult;
    expect(started.root).toBe(await realpath(root));
    await expect(
      inspect?.handle({
        runId: started.runId,
        pages: ["openwiki/page.md"],
      }),
    ).resolves.toEqual({
      pages: [{ page: "/openwiki/page.md", claims: [] }],
    });
    const resolved = (await resolve?.handle({
      runId: started.runId,
      pages: [
        {
          page: "openwiki/page.md",
          operations: [
            {
              op: "add",
              statement: "The repository has a README.",
              evidence: [{ resource: "repo://README.md" }],
            },
          ],
        },
      ],
    })) as {
      pages: Array<{
        page: string;
        results: Array<{ op: string; id: string }>;
      }>;
    };
    expect(resolved.pages).toHaveLength(1);
    expect(resolved.pages[0]?.page).toBe("/openwiki/page.md");
    expect(resolved.pages[0]?.results).toHaveLength(1);
    expect(resolved.pages[0]?.results[0]).toMatchObject({ op: "add" });
    expect(resolved.pages[0]?.results[0]?.id).toMatch(/^claim_/u);
    await mkdir(path.join(root, "openwiki"), { recursive: true });
    await writeFile(
      path.join(root, "openwiki/page.md"),
      "---\ntype: Guide\ntitle: Page\ndescription: Page.\n---\n\n# Page\n",
      "utf8",
    );
    await expect(finish?.handle({ runId: started.runId })).resolves.toEqual({
      status: "complete",
    });
  });
});
