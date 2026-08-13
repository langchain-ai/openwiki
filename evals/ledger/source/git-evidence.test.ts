import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { git } from "../replay/git.js";
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
    expect(corpus.records[0]).toEqual({
      evidenceId: "git:tracked-files",
      sourceRef: "git tracked files",
      observedAtCheckpoint: "T0",
      current: true,
      content:
        "Tracked files reported by git ls-files at checkpoint T0:\n" +
        "- src/value.ts",
    });

    await repo.dispose();
  });

  test("does not follow tracked symbolic links", async () => {
    const repo = await createTinyRepo([
      {
        message: "initial",
        files: { "src/value.ts": "export const VALUE = 1;\n" },
      },
    ]);
    await writeFile(
      path.join(repo.repoPath, "private.txt"),
      "must not become evidence",
      "utf8",
    );
    await symlink("private.txt", path.join(repo.repoPath, "linked.txt"));
    await git(repo.repoPath, ["add", "linked.txt"]);

    const corpus = await collectGitEvidence("T0", repo.repoPath);

    expect(corpus.records[0]?.content).toContain("- linked.txt");
    expect(corpus.records.map((record) => record.sourceRef)).not.toContain(
      "linked.txt",
    );
    expect(
      corpus.records.map((record) => record.content).join("\n"),
    ).not.toContain("must not become evidence");

    await repo.dispose();
  });
});
