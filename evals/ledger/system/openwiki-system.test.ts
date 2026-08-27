import { readdir } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { GitReplay } from "../replay/git-replay.js";
import { OpenWikiSystem } from "./openwiki-system.js";
import { wikiDirFor } from "../core/paths.js";
import { createTinyRepo, type TinyRepo } from "../testing/tiny-repo.js";
import { createWorkspace, type Workspace } from "../replay/workspace.js";

describe.skipIf(!process.env.LEDGER_LIVE)("OpenWikiSystem (live)", () => {
  let repo: TinyRepo;
  let workspace: Workspace;

  beforeEach(async () => {
    repo = await createTinyRepo([
      {
        message: "initial",
        files: {
          "index.ts":
            "export function add(a: number, b: number) {\n  return a + b;\n}\n",
          "README.md": "# Calc\n\nA tiny calculator library.\n",
        },
      },
    ]);
    workspace = await createWorkspace();
  });

  afterEach(async () => {
    await workspace.dispose();
    await repo.dispose();
  });

  test("init produces a non-empty wiki in the worktree", async () => {
    const replay = await GitReplay.create(
      repo.repoPath,
      workspace.worktreeParent,
      repo.shas[0],
    );
    const system = new OpenWikiSystem({
      provider: process.env.OPENWIKI_PROVIDER ?? "anthropic",
      modelId: process.env.OPENWIKI_MODEL_ID,
    });

    const outcome = await system.init(replay.worktreeDir);

    expect(outcome.skipped).toBe(false);
    const entries = await readdir(wikiDirFor(replay.worktreeDir));
    expect(entries.length).toBeGreaterThan(0);

    await replay.teardown();
  }, 300_000);
});
