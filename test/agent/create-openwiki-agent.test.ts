import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { afterEach, describe, expect, test } from "vitest";
import { createOpenWikiAgent } from "../../src/agent/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("createOpenWikiAgent", () => {
  test("requires an absolute runtime root", async () => {
    await expect(
      createOpenWikiAgent({
        command: "init",
        cwd: "relative-repository",
        model: new FakeListChatModel({ responses: ["done"] }),
        outputMode: "repository",
      }),
    ).rejects.toThrow("OpenWiki agent cwd must be an absolute path.");
  });

  test("rejects repository generation before constructing the legacy graph", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-agent-"));
    temporaryDirectories.push(cwd);

    for (const command of ["init", "update"] as const) {
      await expect(
        createOpenWikiAgent({
          command,
          cwd,
          model: new FakeListChatModel({ responses: ["done"] }),
          outputMode: "repository",
        }),
      ).rejects.toThrow(
        "Repository init/update use the OpenWiki page-job runner",
      );
    }
  });

  test("constructs a graph from an initialized chat model", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-agent-"));
    temporaryDirectories.push(cwd);

    const agent = await createOpenWikiAgent({
      command: "init",
      cwd,
      model: new FakeListChatModel({ responses: ["done"] }),
      outputMode: "local-wiki",
    });

    expect(agent).toHaveProperty("invoke");
    expect(agent).toHaveProperty("streamEvents");
  });
});
