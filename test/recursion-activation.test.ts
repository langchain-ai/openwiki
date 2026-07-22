import {
  mkdtemp,
  mkdir,
  rm,
  stat,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  resolveRecursionActivation,
  resolveWorkspaceRuns,
} from "../src/monorepo/workspaces.ts";

/** Writes a package.json workspaces glob and a set of leaf packages. */
async function writePackagesRepo(
  repo: string,
  packages: string[],
): Promise<void> {
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ workspaces: ["packages/*"] }),
    "utf8",
  );
  for (const pkg of packages) {
    await mkdir(path.join(repo, "packages", pkg), { recursive: true });
    await writeFile(
      path.join(repo, "packages", pkg, "package.json"),
      "{}",
      "utf8",
    );
  }
}

function readManifest(repo: string): Promise<string> {
  return readFile(path.join(repo, "openwiki", "workspaces.json"), "utf8");
}

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
    // The `workspaces` list is now detection-owned and regenerated every run, so
    // the manifest path must be a real, detectable workspace to survive the
    // merge (a bare path with no detection source and no override is treated as
    // stale and pruned — see the include/orphan tests below).
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
      "utf8",
    );
    await mkdir(path.join(repo, "packages", "a"), { recursive: true });
    await writeFile(path.join(repo, "packages", "a", "package.json"), "{}");
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

describe("resolveRecursionActivation self-maintaining discovery", () => {
  test("merge: a newly-added project dir appears; existing overrides preserved", async () => {
    const repo = await createRepo();
    await writePackagesRepo(repo, ["a"]);
    // Seed a manifest with an override for the existing project.
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: [{ path: "packages/a" }],
        overrides: { "packages/a": { goal: "the A", name: "Alpha" } },
      }),
      "utf8",
    );

    // A later commit adds packages/b on disk.
    await mkdir(path.join(repo, "packages", "b"), { recursive: true });
    await writeFile(path.join(repo, "packages", "b", "package.json"), "{}");

    const activation = await resolveRecursionActivation(repo, undefined);
    expect(activation.kind).toBe("recurse");
    if (activation.kind !== "recurse") return;

    expect(activation.manifest.workspaces.map((w) => w.path)).toEqual([
      "packages/a",
      "packages/b",
    ]);
    expect(activation.manifest.overrides?.["packages/a"]).toEqual({
      goal: "the A",
      name: "Alpha",
    });
  });

  test("deleted project: path removed from workspaces and its override pruned with a warning", async () => {
    const repo = await createRepo();
    await writePackagesRepo(repo, ["a"]);
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: [{ path: "packages/a" }, { path: "packages/gone" }],
        overrides: { "packages/gone": { goal: "obsolete" } },
      }),
      "utf8",
    );

    const warnings: string[] = [];
    const activation = await resolveRecursionActivation(
      repo,
      undefined,
      (message) => warnings.push(message),
    );
    expect(activation.kind).toBe("recurse");
    if (activation.kind !== "recurse") return;

    expect(activation.manifest.workspaces.map((w) => w.path)).toEqual([
      "packages/a",
    ]);
    expect(activation.manifest.overrides?.["packages/gone"]).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("packages/gone");
  });

  test("idempotent: a second no-op activation does not rewrite the file", async () => {
    const repo = await createRepo();
    await writePackagesRepo(repo, ["a", "b"]);

    await resolveRecursionActivation(repo, true);
    const firstBytes = await readManifest(repo);
    const firstMtime = (
      await stat(path.join(repo, "openwiki", "workspaces.json"))
    ).mtimeMs;

    const second = await resolveRecursionActivation(repo, undefined);
    expect(second.kind).toBe("recurse");
    const secondBytes = await readManifest(repo);
    const secondMtime = (
      await stat(path.join(repo, "openwiki", "workspaces.json"))
    ).mtimeMs;

    expect(secondBytes).toBe(firstBytes);
    expect(secondMtime).toBe(firstMtime);
  });

  test("override preservation: a hand-authored goal/name survives re-detection", async () => {
    const repo = await createRepo();
    await writePackagesRepo(repo, ["a"]);
    await resolveRecursionActivation(repo, true);

    // User hand-edits the manifest to add an override.
    const manifestPath = path.join(repo, "openwiki", "workspaces.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: number;
      workspaces: { path: string }[];
      overrides?: Record<string, unknown>;
    };
    manifest.overrides = { "packages/a": { goal: "hand written", name: "A!" } };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const activation = await resolveRecursionActivation(repo, undefined);
    expect(activation.kind).toBe("recurse");
    if (activation.kind !== "recurse") return;
    expect(activation.manifest.overrides?.["packages/a"]).toEqual({
      goal: "hand written",
      name: "A!",
    });
  });

  test("include/union: an override path detection does not find is still present and produces a run", async () => {
    const repo = await createRepo();
    await writePackagesRepo(repo, ["a"]);
    // A custom grouping detection cannot surface, forced in via include. Give it
    // a goal so getWorkspaceSkipReason would not skip it either.
    await mkdir(path.join(repo, "tools", "grouping"), { recursive: true });
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: [{ path: "packages/a" }],
        overrides: {
          "tools/grouping": { include: true, goal: "custom grouping" },
        },
      }),
      "utf8",
    );

    const activation = await resolveRecursionActivation(repo, undefined);
    expect(activation.kind).toBe("recurse");
    if (activation.kind !== "recurse") return;

    expect(activation.manifest.workspaces.map((w) => w.path)).toEqual([
      "packages/a",
      "tools/grouping",
    ]);
    const plan = resolveWorkspaceRuns(repo, activation.manifest);
    const grouping = plan.runs.find((r) => r.relativePath === "tools/grouping");
    expect(grouping).toBeDefined();
    expect(grouping?.goal).toBe("custom grouping");
  });

  test("legacy flat schema: per-entry goal/name is migrated into overrides and re-emitted", async () => {
    const repo = await createRepo();
    await writePackagesRepo(repo, ["a"]);
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    // Old flat shape: goal/name directly on the workspace entry, no overrides.
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: [{ path: "packages/a", goal: "legacy goal", name: "LegA" }],
      }),
      "utf8",
    );

    const activation = await resolveRecursionActivation(repo, undefined);
    expect(activation.kind).toBe("recurse");
    if (activation.kind !== "recurse") return;

    // The goal/name migrated into overrides; workspaces entries are path-only.
    expect(activation.manifest.workspaces).toEqual([{ path: "packages/a" }]);
    expect(activation.manifest.overrides?.["packages/a"]).toEqual({
      goal: "legacy goal",
      name: "LegA",
    });

    // The written file is the new shape and still carries the goal.
    const written = JSON.parse(await readManifest(repo)) as {
      workspaces: { path: string; goal?: string }[];
      overrides?: Record<string, { goal?: string; name?: string }>;
    };
    expect(written.workspaces).toEqual([{ path: "packages/a" }]);
    expect(written.overrides?.["packages/a"]?.goal).toBe("legacy goal");
  });

  test("determinism: two runs produce byte-identical, sorted output", async () => {
    const repo = await createRepo();
    await writePackagesRepo(repo, ["b", "a", "c"]);
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    // Overrides deliberately out of key order; the write must sort them.
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: [{ path: "packages/c" }],
        overrides: {
          "packages/c": { name: "C" },
          "packages/a": { name: "A" },
        },
      }),
      "utf8",
    );

    await resolveRecursionActivation(repo, undefined);
    const first = await readManifest(repo);
    await resolveRecursionActivation(repo, undefined);
    const second = await readManifest(repo);

    expect(second).toBe(first);
    const parsed = JSON.parse(first) as {
      workspaces: { path: string }[];
      overrides: Record<string, unknown>;
    };
    expect(parsed.workspaces.map((w) => w.path)).toEqual([
      "packages/a",
      "packages/b",
      "packages/c",
    ]);
    expect(Object.keys(parsed.overrides)).toEqual(["packages/a", "packages/c"]);
  });

  test("BUG1: a legacy path-only manual entry for a non-detected but existing dir survives (promoted to include), no data loss", async () => {
    const repo = await createRepo();
    await writePackagesRepo(repo, ["a"]);
    // A hand-added service OUTSIDE the packages/* glob: detection cannot surface
    // it, but the directory really exists, so it is a deliberate manual grouping.
    await mkdir(path.join(repo, "services", "legacy-svc"), { recursive: true });
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: [{ path: "packages/a" }, { path: "services/legacy-svc" }],
      }),
      "utf8",
    );

    const warnings: string[] = [];
    const activation = await resolveRecursionActivation(
      repo,
      undefined,
      (message) => warnings.push(message),
    );
    expect(activation.kind).toBe("recurse");
    if (activation.kind !== "recurse") return;

    // The manual path is preserved (not silently dropped) and promoted to an
    // explicit include so it is stable across future runs.
    expect(activation.manifest.workspaces.map((w) => w.path)).toEqual([
      "packages/a",
      "services/legacy-svc",
    ]);
    expect(activation.manifest.overrides?.["services/legacy-svc"]).toEqual({
      include: true,
    });
    expect(warnings).toEqual([]);

    // And it produces a run downstream (it has source, so it is not skipped).
    const plan = resolveWorkspaceRuns(repo, activation.manifest);
    expect(plan.runs.map((r) => r.relativePath)).toContain(
      "services/legacy-svc",
    );
  });

  test("BUG1: a legacy goal-only manual entry for a non-detected but existing dir keeps its goal (promoted to include)", async () => {
    const repo = await createRepo();
    await writePackagesRepo(repo, ["a"]);
    await mkdir(path.join(repo, "services", "legacy-svc"), { recursive: true });
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: [
          { path: "packages/a" },
          { path: "services/legacy-svc", goal: "keep me" },
        ],
      }),
      "utf8",
    );

    const activation = await resolveRecursionActivation(repo, undefined);
    expect(activation.kind).toBe("recurse");
    if (activation.kind !== "recurse") return;

    expect(activation.manifest.overrides?.["services/legacy-svc"]).toEqual({
      goal: "keep me",
      include: true,
    });
    const plan = resolveWorkspaceRuns(repo, activation.manifest);
    const run = plan.runs.find((r) => r.relativePath === "services/legacy-svc");
    expect(run?.goal).toBe("keep me");
  });

  test("BUG1 counterpart: a legacy manual entry for a dir that no longer exists is dropped (managed entry: quiet; override: warned)", async () => {
    const repo = await createRepo();
    await writePackagesRepo(repo, ["a"]);
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    // Neither path exists on disk. One is a bare managed entry (quiet removal),
    // the other carries an override (intent discarded → warn).
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: [
          { path: "packages/a" },
          { path: "services/bare-gone" },
          { path: "services/customized-gone" },
        ],
        overrides: { "services/customized-gone": { goal: "obsolete" } },
      }),
      "utf8",
    );

    const warnings: string[] = [];
    const activation = await resolveRecursionActivation(
      repo,
      undefined,
      (message) => warnings.push(message),
    );
    expect(activation.kind).toBe("recurse");
    if (activation.kind !== "recurse") return;

    expect(activation.manifest.workspaces.map((w) => w.path)).toEqual([
      "packages/a",
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("services/customized-gone");
  });

  test("BUG2: an include override overlapping a detected path does NOT wedge — it is pruned + warned and the run proceeds", async () => {
    const repo = await createRepo();
    await writePackagesRepo(repo, ["a"]);
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    // `packages` is an ancestor of the detected `packages/a`; a naive union
    // would persist both and make resolveWorkspaceRuns throw on every future
    // default run (manifest present ⇒ auto-recurse ⇒ throw).
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: [{ path: "packages/a" }],
        overrides: { packages: { include: true } },
      }),
      "utf8",
    );

    const warnings: string[] = [];
    const activation = await resolveRecursionActivation(
      repo,
      undefined,
      (message) => warnings.push(message),
    );
    expect(activation.kind).toBe("recurse");
    if (activation.kind !== "recurse") return;

    // The overlapping include is pruned; only the detected leaf remains.
    expect(activation.manifest.workspaces.map((w) => w.path)).toEqual([
      "packages/a",
    ]);
    expect(activation.manifest.overrides?.packages).toBeUndefined();
    expect(warnings.some((w) => w.includes("packages"))).toBe(true);

    // The written manifest must resolve cleanly (invariant restored): a
    // subsequent default run does not throw.
    const second = await resolveRecursionActivation(repo, undefined);
    expect(second.kind).toBe("recurse");
    if (second.kind === "recurse") {
      expect(() => resolveWorkspaceRuns(repo, second.manifest)).not.toThrow();
    }
  });

  test("#7 .NET coarsening: a per-project override orphaned when detection collapses to the area is dropped + warned, never wedges", async () => {
    const repo = await createRepo();
    // Detection coarsens the src/tests projects of an area to the area root, so
    // it emits `platform/admission`, not `platform/admission/src/...`.
    await writeFile(
      path.join(repo, "App.sln"),
      [
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "platform\\admission\\src\\Core.Admission.Api\\Core.Admission.Api.csproj", "{11111111-1111-1111-1111-111111111111}"',
        "EndProject",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(
      path.join(repo, "platform", "admission", "src", "Core.Admission.Api"),
      {
        recursive: true,
      },
    );
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    // A stale manifest keyed at the per-PROJECT granularity (pre-coarsening).
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: [{ path: "platform/admission/src/Core.Admission.Api" }],
        overrides: {
          "platform/admission/src/Core.Admission.Api": { goal: "stale" },
        },
      }),
      "utf8",
    );

    const warnings: string[] = [];
    const activation = await resolveRecursionActivation(
      repo,
      undefined,
      (message) => warnings.push(message),
    );
    expect(activation.kind).toBe("recurse");
    if (activation.kind !== "recurse") return;

    // Only the coarsened area survives; the per-project path (whose dir exists
    // but overlaps the detected area) is pruned + warned rather than persisted
    // into an unresolvable manifest.
    expect(activation.manifest.workspaces.map((w) => w.path)).toEqual([
      "platform/admission",
    ]);
    expect(
      activation.manifest.overrides?.[
        "platform/admission/src/Core.Admission.Api"
      ],
    ).toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(
      warnings.some((w) =>
        w.includes("platform/admission/src/Core.Admission.Api"),
      ),
    ).toBe(true);
    expect(() => resolveWorkspaceRuns(repo, activation.manifest)).not.toThrow();
  });
});
