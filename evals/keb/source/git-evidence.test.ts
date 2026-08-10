import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTinyRepo } from "../testing/tiny-repo.js";
import { collectGitEvidence } from "./git-evidence.js";

describe("collectGitEvidence", () => {
  test("collects stable tracked text while excluding untracked artifacts", async () => {
    const repo = await createTinyRepo([
      {
        message: "initial",
        files: { "src/value.ts": "export const VALUE = 1;\n" },
      },
    ]);
    await mkdir(path.join(repo.repoPath, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repo.repoPath, "openwiki", "generated.md"),
      "generated",
    );

    const corpus = await collectGitEvidence("T0", repo.repoPath);

    expect(corpus.checkpointId).toBe("T0");
    expect(corpus.records.map((record) => record.sourceRef)).not.toContain(
      "openwiki/generated.md",
    );
    expect(corpus.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceId: expect.stringMatching(/::0000$/),
        }),
      ]),
    );

    await repo.dispose();
  });
});
