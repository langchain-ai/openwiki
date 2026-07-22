import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  resolveRecursionActivation,
  resolveWorkspaceRuns,
} from "../src/monorepo/workspaces.ts";

const tempDirs: string[] = [];

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-activate-"));
  tempDirs.push(repo);
  return repo;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("resolveRecursionActivation", () => {
  test("recurses when a manifest exists (default flag)", async () => {
    const repo = await createRepo();
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      JSON.stringify({ version: 1, workspaces: [{ path: "packages/a" }] }),
      "utf8",
    );

    const activation = await resolveRecursionActivation(repo, undefined);
    expect(activation.kind).toBe("recurse");
    if (activation.kind === "recurse") {
      expect(activation.autoDetected).toBe(false);
      expect(activation.manifest.workspaces).toHaveLength(1);
    }
  });

  test("--recursive=false forces plain even with a manifest", async () => {
    const repo = await createRepo();
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      JSON.stringify({ version: 1, workspaces: [{ path: "packages/a" }] }),
      "utf8",
    );

    const activation = await resolveRecursionActivation(repo, false);
    expect(activation.kind).toBe("plain");
  });

  test("default with no manifest is a plain run", async () => {
    const repo = await createRepo();
    const activation = await resolveRecursionActivation(repo, undefined);
    expect(activation.kind).toBe("plain");
  });

  test("--recursive with no manifest auto-detects and writes a manifest", async () => {
    const repo = await createRepo();
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
      "utf8",
    );
    await mkdir(path.join(repo, "packages", "a"), { recursive: true });
    await writeFile(path.join(repo, "packages", "a", "package.json"), "{}");

    const activation = await resolveRecursionActivation(repo, true);
    expect(activation.kind).toBe("recurse");
    if (activation.kind === "recurse") {
      expect(activation.autoDetected).toBe(true);
    }

    // The manifest was written for the user to review.
    const written = JSON.parse(
      await readFile(path.join(repo, "openwiki", "workspaces.json"), "utf8"),
    ) as { version: number; workspaces: { path: string }[] };
    expect(written.version).toBe(1);
    expect(written.workspaces).toEqual([{ path: "packages/a" }]);
  });

  test("--recursive with no manifest and no detectable workspaces falls back to plain", async () => {
    const repo = await createRepo();
    const activation = await resolveRecursionActivation(repo, true);
    expect(activation.kind).toBe("plain");
    if (activation.kind === "plain") {
      expect(activation.reason).toMatch(/no monorepo workspaces were detected/);
    }
  });

  test("auto-detect on a packages/** repo writes a manifest that resolves cleanly (no self-poison)", async () => {
    const repo = await createRepo();
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ workspaces: ["packages/**"] }),
      "utf8",
    );
    await mkdir(path.join(repo, "packages", "a"), { recursive: true });
    await writeFile(path.join(repo, "packages", "a", "package.json"), "{}");
    await mkdir(path.join(repo, "packages", "b", "sub"), { recursive: true });
    await writeFile(
      path.join(repo, "packages", "b", "sub", "package.json"),
      "{}",
    );

    const activation = await resolveRecursionActivation(repo, true);
    expect(activation.kind).toBe("recurse");

    // A subsequent DEFAULT run (no flag) reads the written manifest and must not
    // throw — this is the "stuck repo" regression.
    const second = await resolveRecursionActivation(repo, undefined);
    expect(second.kind).toBe("recurse");
    if (second.kind === "recurse") {
      const plan = resolveWorkspaceRuns(repo, second.manifest);
      expect(plan.runs.map((run) => run.relativePath).sort()).toEqual([
        "packages/a",
        "packages/b/sub",
      ]);
    }
  });
});
