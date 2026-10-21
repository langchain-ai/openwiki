import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createRetrievalTools } from "../../src/integrations/core/retrieval-tools.ts";
import { saveWikiWorkspaces } from "../../src/linking/wiki-workspaces.ts";

type RegisteredTool = {
  name: string;
  executionMode?: "sequential" | "parallel";
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<{ details: unknown }>;
};

type Extension = (pi: {
  registerTool(tool: RegisteredTool): void;
  on(event: string, handler: () => Promise<void>): void;
}) => void;

const extensionModule: unknown =
  await import("../../dist/integrations/pi/openwiki.js");
const extension = (extensionModule as { default: Extension }).default;

type Schema = Record<string, unknown>;

type ExtensionHarness = {
  tools: Map<string, RegisteredTool>;
  shutdown: (() => Promise<void>) | undefined;
};

const harnesses: ExtensionHarness[] = [];
const temporaryRoots: string[] = [];
const originalConfigDirectory = process.env.OPENWIKI_CONFIG_DIR;

function createHarness(): ExtensionHarness {
  const harness: ExtensionHarness = {
    tools: new Map(),
    shutdown: undefined,
  };
  extension({
    registerTool(tool: RegisteredTool) {
      harness.tools.set(tool.name, tool);
    },
    on(event: string, handler: () => Promise<void>) {
      if (event === "session_shutdown") harness.shutdown = handler;
    },
  });
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.shutdown?.();
  if (originalConfigDirectory === undefined) {
    delete process.env.OPENWIKI_CONFIG_DIR;
  } else {
    process.env.OPENWIKI_CONFIG_DIR = originalConfigDirectory;
  }
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("native Pi package extension", () => {
  test("registers exactly the canonical OpenWiki tools", () => {
    const harness = createHarness();
    expect([...harness.tools.keys()]).toEqual([
      "openwiki_list_workspaces",
      "openwiki_list_wikis",
      "openwiki_search",
      "openwiki_read",
      "openwiki_begin",
      "openwiki_submit_plan",
      "openwiki_next_page",
      "openwiki_inspect_page_claims",
      "openwiki_submit_page",
      "openwiki_finish",
    ]);
    expect(
      [...harness.tools.values()].map((tool) => tool.executionMode),
    ).toEqual(Array(10).fill("sequential"));
  });

  test("publishes the shared retrieval schemas", () => {
    const harness = createHarness();
    for (const definition of createRetrievalTools()) {
      expect(harness.tools.get(definition.name)?.parameters).toEqual(
        z.toJSONSchema(definition.schema, { target: "draft-07" }),
      );
    }
  });

  test("publishes strict nested protocol schemas", () => {
    const harness = createHarness();
    const plan = harness.tools.get("openwiki_submit_plan")!;
    const planParameters = plan.parameters as {
      properties: Record<string, Schema>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(planParameters).toMatchObject({
      required: ["runId", "pages"],
      additionalProperties: false,
    });
    expect(planParameters.properties.runId).toMatchObject({
      type: "string",
      format: "uuid",
    });
    expect(planParameters.properties.pages).toMatchObject({
      type: "array",
    });
    const pageSchema = planParameters.properties.pages.items as Schema;
    expect(pageSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(pageSchema.properties).toMatchObject({
      path: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      purpose: { type: "string", minLength: 1 },
    });

    const submit = harness.tools.get("openwiki_submit_page")!;
    const submitParameters = submit.parameters as {
      properties: Record<string, Schema>;
    };
    const claimSchema = submitParameters.properties.claims.items as Schema;
    expect(claimSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    const claimProperties = claimSchema.properties as Record<string, Schema>;
    expect(claimProperties.statement).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(claimProperties.evidence).toMatchObject({
      type: "array",
      minItems: 1,
    });
  });

  test("starts MCP lazily, forwards validation errors, and shuts down", async () => {
    const harness = createHarness();
    const begin = harness.tools.get("openwiki_begin");
    expect(begin).toBeDefined();

    await expect(begin!.execute("invalid-input", {})).rejects.toThrow(
      /invalid|argument|schema/i,
    );
    expect(harness.shutdown).toBeDefined();
    await expect(harness.shutdown!()).resolves.toBeUndefined();
  }, 20_000);

  test("discovers, searches, and reads linked wikis through MCP without generation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openwiki-pi-"));
    temporaryRoots.push(directory);
    process.env.OPENWIKI_CONFIG_DIR = path.join(directory, "config");
    const controlPlane = path.join(directory, "control-plane");
    const dataPlane = path.join(directory, "data-plane");
    for (const root of [controlPlane, dataPlane]) {
      await mkdir(path.join(root, "openwiki"), { recursive: true });
      execFileSync("git", ["init", "--quiet", root]);
      await writeFile(path.join(root, "openwiki/.last-update.json"), "{}\n");
    }
    await writeFile(
      path.join(controlPlane, "openwiki/routing.md"),
      "# Control Plane Routing\n\n## Route publication\n\nThe control plane publishes signed route snapshots to every data-plane cell.\n",
    );
    await saveWikiWorkspaces([
      { name: "Payments", roots: [controlPlane, dataPlane] },
    ]);
    const harness = createHarness();

    await expect(
      harness.tools.get("openwiki_list_workspaces")!.execute("workspaces", {
        root: dataPlane,
      }),
    ).resolves.toMatchObject({
      details: { workspaces: [{ id: "payments", wikiCount: 2 }] },
    });
    await expect(
      harness.tools.get("openwiki_list_wikis")!.execute("wikis", {
        root: dataPlane,
        workspace: "payments",
      }),
    ).resolves.toMatchObject({
      details: {
        wikis: [{ id: "control-plane" }, { id: "data-plane" }],
      },
    });
    const search = await harness.tools
      .get("openwiki_search")!
      .execute("search", {
        root: dataPlane,
        query: "Who publishes signed route snapshots?",
      });
    const { results } = z
      .object({
        results: z.array(
          z.object({ wiki: z.string(), ref: z.array(z.string()) }),
        ),
      })
      .parse(search.details);
    expect(results[0]).toEqual({
      wiki: "control-plane",
      ref: ["openwiki/routing.md#route-publication"],
    });
    const [page, section] = results[0].ref[0].split("#");
    await expect(
      harness.tools.get("openwiki_read")!.execute("read", {
        root: dataPlane,
        wiki: results[0].wiki,
        page,
        sections: [section],
      }),
    ).resolves.toMatchObject({
      details: {
        wiki: "control-plane",
        sections: [
          {
            section: "route-publication",
            content:
              "## Route publication\n\nThe control plane publishes signed route snapshots to every data-plane cell.",
          },
        ],
      },
    });
    await expect(
      harness.tools.get("openwiki_read")!.execute("missing-section", {
        root: dataPlane,
        wiki: results[0].wiki,
        page,
        sections: ["missing"],
      }),
    ).rejects.toThrow("Unknown section: missing");
    expect((await readdir(dataPlane)).sort()).toEqual([".git", "openwiki"]);
    expect(await readdir(path.join(dataPlane, "openwiki"))).toEqual([
      ".last-update.json",
    ]);
  }, 20_000);
});
