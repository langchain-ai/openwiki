import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { lstat, readFile } from "node:fs/promises";
import {
  detectWorkspaces,
  getWorkspaceSkipReason,
  normalizeManifest,
  readWorkspaceManifest,
  resolveWorkspaceRuns,
  writeGeneratedFile,
  type WorkspaceManifest,
} from "../src/monorepo/workspaces.ts";

const tempDirs: string[] = [];

async function createTempRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-workspaces-"));
  tempDirs.push(repo);
  return repo;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("readWorkspaceManifest", () => {
  test("returns null when no manifest exists", async () => {
    const repo = await createTempRepo();
    expect(await readWorkspaceManifest(repo)).toBeNull();
  });

  test("reads a valid manifest with goals and root brief", async () => {
    const repo = await createTempRepo();
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: [{ path: "packages/core", goal: "the core", name: "Core" }],
        root: { goal: "root brief" },
      }),
      "utf8",
    );

    const manifest = await readWorkspaceManifest(repo);
    expect(manifest).not.toBeNull();
    expect(manifest?.workspaces[0]).toEqual({
      path: "packages/core",
      goal: "the core",
      name: "Core",
    });
    expect(manifest?.root?.goal).toBe("root brief");
  });

  test("throws on malformed JSON", async () => {
    const repo = await createTempRepo();
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repo, "openwiki", "workspaces.json"),
      "{ not json",
      "utf8",
    );
    await expect(readWorkspaceManifest(repo)).rejects.toThrow(/not valid JSON/);
  });
});

describe("normalizeManifest", () => {
  test("rejects unsupported versions", () => {
    expect(() => normalizeManifest({ version: 2, workspaces: [] })).toThrow(
      /version 2 is unsupported/,
    );
  });

  test("rejects a missing workspaces array", () => {
    expect(() => normalizeManifest({ version: 1 })).toThrow(
      /must contain a `workspaces` array/,
    );
  });

  test("rejects a workspace entry without a string path", () => {
    expect(() =>
      normalizeManifest({ version: 1, workspaces: [{ goal: "x" }] }),
    ).toThrow(/must be an object with a string `path`/);
  });

  test("accepts a missing version (defaults to 1)", () => {
    const manifest = normalizeManifest({ workspaces: [{ path: "a" }] });
    expect(manifest.version).toBe(1);
  });

  test("parses an overrides map, keeping only recognized typed fields", () => {
    const manifest = normalizeManifest({
      version: 1,
      workspaces: [{ path: "a" }],
      overrides: {
        a: {
          goal: "g",
          name: "N",
          exclude: true,
          include: false,
          bogus: 42,
        },
      },
    });
    expect(manifest.overrides?.a).toEqual({
      goal: "g",
      name: "N",
      exclude: true,
      include: false,
    });
  });

  test("migrates legacy per-entry goal/name into overrides (explicit override wins)", () => {
    const manifest = normalizeManifest({
      version: 1,
      workspaces: [
        { path: "a", goal: "legacy a", name: "LegacyA" },
        { path: "b", goal: "legacy b" },
      ],
      overrides: { a: { goal: "explicit a" } },
    });
    // Explicit override goal wins; the missing name is filled from the entry.
    expect(manifest.overrides?.a).toEqual({
      goal: "explicit a",
      name: "LegacyA",
    });
    // A legacy entry with no override migrates wholesale.
    expect(manifest.overrides?.b).toEqual({ goal: "legacy b" });
  });
});

describe("resolveWorkspaceRuns", () => {
  const repoRoot = "/repo";

  function manifest(
    workspaces: WorkspaceManifest["workspaces"],
    root?: WorkspaceManifest["root"],
  ): WorkspaceManifest {
    return { version: 1, workspaces, ...(root ? { root } : {}) };
  }

  test("normalizes paths and resolves absolute paths", () => {
    const plan = resolveWorkspaceRuns(
      repoRoot,
      manifest([{ path: "packages/core/" }], { goal: "  root  " }),
    );
    expect(plan.runs).toHaveLength(1);
    expect(plan.runs[0].relativePath).toBe("packages/core");
    expect(plan.runs[0].absolutePath).toBe(path.resolve("/repo/packages/core"));
    expect(plan.rootGoal).toBe("root");
  });

  test("dedupes repeated paths", () => {
    const plan = resolveWorkspaceRuns(
      repoRoot,
      manifest([{ path: "packages/a" }, { path: "packages/a/" }]),
    );
    expect(plan.runs).toHaveLength(1);
  });

  test("rejects a workspace equal to the repo root", () => {
    expect(() =>
      resolveWorkspaceRuns(repoRoot, manifest([{ path: "." }])),
    ).toThrow(/may not be the repository root/);
    expect(() =>
      resolveWorkspaceRuns(repoRoot, manifest([{ path: "" }])),
    ).toThrow(/may not be the repository root/);
  });

  test("rejects absolute paths", () => {
    expect(() =>
      resolveWorkspaceRuns(repoRoot, manifest([{ path: "/etc" }])),
    ).toThrow(/absolute paths are not allowed/);
  });

  test("rejects .. traversal", () => {
    expect(() =>
      resolveWorkspaceRuns(repoRoot, manifest([{ path: "../evil" }])),
    ).toThrow(/may not escape the repository root/);
    expect(() =>
      resolveWorkspaceRuns(repoRoot, manifest([{ path: "packages/../../x" }])),
    ).toThrow(/may not escape the repository root/);
  });

  test("rejects nested/overlapping workspaces", () => {
    expect(() =>
      resolveWorkspaceRuns(
        repoRoot,
        manifest([{ path: "packages/foo" }, { path: "packages/foo/bar" }]),
      ),
    ).toThrow(/is an ancestor of/);
  });

  test("allows sibling workspaces with a shared prefix name", () => {
    const plan = resolveWorkspaceRuns(
      repoRoot,
      manifest([{ path: "packages/foo" }, { path: "packages/foobar" }]),
    );
    expect(plan.runs).toHaveLength(2);
  });

  test("empty workspaces produce an empty plan", () => {
    const plan = resolveWorkspaceRuns(repoRoot, manifest([]));
    expect(plan.runs).toHaveLength(0);
  });

  test("an override with exclude:true produces no run", () => {
    const plan = resolveWorkspaceRuns(repoRoot, {
      version: 1,
      workspaces: [{ path: "packages/a" }, { path: "packages/b" }],
      overrides: { "packages/b": { exclude: true } },
    });
    expect(plan.runs.map((run) => run.relativePath)).toEqual(["packages/a"]);
  });

  test("an override goal/name takes precedence over a legacy per-entry value", () => {
    const plan = resolveWorkspaceRuns(repoRoot, {
      version: 1,
      workspaces: [{ path: "packages/a", goal: "entry goal", name: "Entry" }],
      overrides: { "packages/a": { goal: "override goal", name: "Override" } },
    });
    expect(plan.runs[0].goal).toBe("override goal");
    expect(plan.runs[0].name).toBe("Override");
  });

  test("falls back to a legacy per-entry goal/name when no override exists", () => {
    const plan = resolveWorkspaceRuns(repoRoot, {
      version: 1,
      workspaces: [{ path: "packages/a", goal: "entry goal", name: "Entry" }],
    });
    expect(plan.runs[0].goal).toBe("entry goal");
    expect(plan.runs[0].name).toBe("Entry");
  });
});

describe("getWorkspaceSkipReason", () => {
  test("returns null for a workspace with a package.json", async () => {
    const repo = await createTempRepo();
    await mkdir(path.join(repo, "packages/foo"), { recursive: true });
    await writeFile(path.join(repo, "packages/foo/package.json"), "{}", "utf8");
    const [run] = resolveWorkspaceRuns(repo, {
      version: 1,
      workspaces: [{ path: "packages/foo" }],
    }).runs;
    expect(await getWorkspaceSkipReason(repo, run)).toBeNull();
  });

  test("skips a workspace with no manifest, no instructions, no goal, no source", async () => {
    const repo = await createTempRepo();
    await mkdir(path.join(repo, "packages/empty"), { recursive: true });
    const [run] = resolveWorkspaceRuns(repo, {
      version: 1,
      workspaces: [{ path: "packages/empty" }],
    }).runs;
    expect(await getWorkspaceSkipReason(repo, run)).toMatch(/no source files/);
  });

  test("does not skip when a goal is provided even with no source", async () => {
    const repo = await createTempRepo();
    await mkdir(path.join(repo, "packages/empty"), { recursive: true });
    const [run] = resolveWorkspaceRuns(repo, {
      version: 1,
      workspaces: [{ path: "packages/empty", goal: "document me" }],
    }).runs;
    expect(await getWorkspaceSkipReason(repo, run)).toBeNull();
  });

  test("does not skip when openwiki/INSTRUCTIONS.md is present", async () => {
    const repo = await createTempRepo();
    await mkdir(path.join(repo, "packages/foo/openwiki"), { recursive: true });
    await writeFile(
      path.join(repo, "packages/foo/openwiki/INSTRUCTIONS.md"),
      "brief\n",
      "utf8",
    );
    const [run] = resolveWorkspaceRuns(repo, {
      version: 1,
      workspaces: [{ path: "packages/foo" }],
    }).runs;
    expect(await getWorkspaceSkipReason(repo, run)).toBeNull();
  });

  test("skips a missing directory", async () => {
    const repo = await createTempRepo();
    const [run] = resolveWorkspaceRuns(repo, {
      version: 1,
      workspaces: [{ path: "packages/ghost" }],
    }).runs;
    expect(await getWorkspaceSkipReason(repo, run)).toMatch(/does not exist/);
  });

  test("rejects a symlink that escapes the repository", async () => {
    const repo = await createTempRepo();
    const outside = await createTempRepo();
    await mkdir(path.join(repo, "packages"), { recursive: true });
    await symlink(outside, path.join(repo, "packages/escape"));
    const [run] = resolveWorkspaceRuns(repo, {
      version: 1,
      workspaces: [{ path: "packages/escape" }],
    }).runs;
    expect(await getWorkspaceSkipReason(repo, run)).toMatch(/symlink escape/);
  });
});

describe("detectWorkspaces", () => {
  test("returns [] with no monorepo manifests", async () => {
    const repo = await createTempRepo();
    expect(await detectWorkspaces(repo)).toEqual([]);
  });

  test("does not wedge when a manifest name is a directory (EISDIR)", async () => {
    const repo = await createTempRepo();
    // A directory named like a manifest makes readFile throw EISDIR; detection
    // must treat it as "no manifest here" rather than propagating the error.
    await mkdir(path.join(repo, "pom.xml"), { recursive: true });
    await mkdir(path.join(repo, "package.json"), { recursive: true });
    await expect(detectWorkspaces(repo)).resolves.toEqual([]);
  });

  test("expands package.json workspaces globs into existing dirs", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
      "utf8",
    );
    await mkdir(path.join(repo, "packages/a"), { recursive: true });
    await mkdir(path.join(repo, "packages/b"), { recursive: true });
    await writeFile(path.join(repo, "packages/a/package.json"), "{}", "utf8");
    await writeFile(path.join(repo, "packages/b/package.json"), "{}", "utf8");

    const detected = await detectWorkspaces(repo);
    expect(detected.map((entry) => entry.path).sort()).toEqual([
      "packages/a",
      "packages/b",
    ]);
  });

  test("expands pnpm-workspace.yaml packages", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n",
      "utf8",
    );
    await mkdir(path.join(repo, "apps/web"), { recursive: true });
    const detected = await detectWorkspaces(repo);
    expect(detected.map((entry) => entry.path)).toEqual(["apps/web"]);
  });

  test("expands Cargo.toml [workspace] members", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "Cargo.toml"),
      '[workspace]\nmembers = ["crates/one", "crates/two"]\n',
      "utf8",
    );
    await mkdir(path.join(repo, "crates/one"), { recursive: true });
    await mkdir(path.join(repo, "crates/two"), { recursive: true });
    const detected = await detectWorkspaces(repo);
    expect(detected.map((entry) => entry.path).sort()).toEqual([
      "crates/one",
      "crates/two",
    ]);
  });

  test("expands go.work use directives", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "go.work"),
      "go 1.22\n\nuse (\n\t./svc/a\n\t./svc/b\n)\n",
      "utf8",
    );
    await mkdir(path.join(repo, "svc/a"), { recursive: true });
    await mkdir(path.join(repo, "svc/b"), { recursive: true });
    const detected = await detectWorkspaces(repo);
    expect(detected.map((entry) => entry.path).sort()).toEqual([
      "svc/a",
      "svc/b",
    ]);
  });

  test("expands ** globs to leaf package dirs, not intermediates", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ workspaces: ["packages/**"] }),
      "utf8",
    );
    // A nested package inside a container that is itself NOT a package. Only the
    // leaf package (has a manifest) should be detected; the container must not.
    await mkdir(path.join(repo, "packages/group/nested"), { recursive: true });
    await writeFile(
      path.join(repo, "packages/group/nested/package.json"),
      "{}",
      "utf8",
    );

    const detected = await detectWorkspaces(repo);
    const paths = detected.map((entry) => entry.path);
    expect(paths).toContain("packages/group/nested");
    expect(paths).not.toContain("packages/group");
    expect(paths).not.toContain("packages");
  });

  test("common packages/* glob does not emit the container", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
      "utf8",
    );
    await mkdir(path.join(repo, "packages/a"), { recursive: true });
    await writeFile(path.join(repo, "packages/a/package.json"), "{}", "utf8");

    const detected = await detectWorkspaces(repo);
    const paths = detected.map((entry) => entry.path);
    expect(paths).toEqual(["packages/a"]);
    expect(paths).not.toContain("packages");
  });

  describe(".NET solution (.sln / .slnx)", () => {
    test("expands classic .sln project directories", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "App.sln"),
        [
          "Microsoft Visual Studio Solution File, Format Version 12.00",
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "src\\Api\\Api.csproj", "{11111111-1111-1111-1111-111111111111}"',
          "EndProject",
          'Project("{F184B08F-C81C-45F6-A57F-5ABD9991F28F}") = "Lib", "src\\Lib\\Lib.vbproj", "{22222222-2222-2222-2222-222222222222}"',
          "EndProject",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "src/Api"), { recursive: true });
      await mkdir(path.join(repo, "src/Lib"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path).sort()).toEqual([
        "src/Api",
        "src/Lib",
      ]);
    });

    test("skips solution-folder entries in a .sln", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "App.sln"),
        [
          'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "SolutionItems", "SolutionItems", "{33333333-3333-3333-3333-333333333333}"',
          "EndProject",
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "src\\Api\\Api.csproj", "{11111111-1111-1111-1111-111111111111}"',
          "EndProject",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "src/Api"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      const paths = detected.map((entry) => entry.path);
      expect(paths).toEqual(["src/Api"]);
      expect(paths).not.toContain("SolutionItems");
    });

    test("expands .slnx <Project Path> entries and ignores <Folder>", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "App.slnx"),
        [
          "<Solution>",
          '  <Folder Name="/Solution Items/">',
          '    <File Path="README.md" />',
          "  </Folder>",
          '  <Project Path="src\\Web\\Web.csproj" Type="Classic C#" />',
          '  <Project Path="src\\Core\\Core.fsproj" />',
          "</Solution>",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "src/Web"), { recursive: true });
      await mkdir(path.join(repo, "src/Core"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path).sort()).toEqual([
        "src/Core",
        "src/Web",
      ]);
    });

    test("parses a CRLF .sln (real solution files use CRLF)", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "App.sln"),
        [
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "src\\Api\\Api.csproj", "{11111111-1111-1111-1111-111111111111}"',
          "EndProject",
          "",
        ].join("\r\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "src/Api"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path)).toEqual(["src/Api"]);
    });

    test("parses a .slnx with single-quoted Path", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "App.slnx"),
        [
          "<Solution>",
          "  <Project Path='src/Api/Api.csproj' />",
          "</Solution>",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "src/Api"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path)).toEqual(["src/Api"]);
    });

    test("malformed .sln returns no .NET workspaces", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "App.sln"),
        "this is not a solution file at all",
        "utf8",
      );
      expect(await detectWorkspaces(repo)).toEqual([]);
    });

    test("coarsens an area's src/tests projects to the area root", async () => {
      // The .NET DDD convention nests projects under an intermediate src/ or
      // tests/ dir inside a product area. All three projects below belong to the
      // ONE area `platform/admission`, so detection must collapse to it rather
      // than emitting one workspace per .csproj.
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "App.sln"),
        [
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "platform\\admission\\src\\Core.Admission.Api\\Core.Admission.Api.csproj", "{11111111-1111-1111-1111-111111111111}"',
          "EndProject",
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Domain", "platform\\admission\\src\\Core.Admission.Domain\\Core.Admission.Domain.csproj", "{22222222-2222-2222-2222-222222222222}"',
          "EndProject",
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "DomainTests", "platform\\admission\\tests\\Core.Admission.Domain.Tests\\Core.Admission.Domain.Tests.csproj", "{33333333-3333-3333-3333-333333333333}"',
          "EndProject",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "platform/admission"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path)).toEqual([
        "platform/admission",
      ]);
    });

    test("leaves a flat lib (project dir directly under a container) unchanged", async () => {
      // A project whose immediate parent is neither src nor tests (a flatter lib
      // like kernel/Core.Domain.Kernel) has nothing to trim and stays as-is.
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "App.sln"),
        [
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Kernel", "kernel\\Core.Domain.Kernel\\Core.Domain.Kernel.csproj", "{11111111-1111-1111-1111-111111111111}"',
          "EndProject",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "kernel/Core.Domain.Kernel"), {
        recursive: true,
      });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path)).toEqual([
        "kernel/Core.Domain.Kernel",
      ]);
    });

    test("mixes coarsened areas and flat libs into a deduped, non-overlapping set", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "App.sln"),
        [
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "platform\\admission\\src\\Core.Admission.Api\\Core.Admission.Api.csproj", "{11111111-1111-1111-1111-111111111111}"',
          "EndProject",
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Tests", "platform\\admission\\tests\\Core.Admission.Api.Tests\\Core.Admission.Api.Tests.csproj", "{22222222-2222-2222-2222-222222222222}"',
          "EndProject",
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "BillingApi", "platform\\billing\\src\\Core.Billing.Api\\Core.Billing.Api.csproj", "{33333333-3333-3333-3333-333333333333}"',
          "EndProject",
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Kernel", "kernel\\Core.Domain.Kernel\\Core.Domain.Kernel.csproj", "{44444444-4444-4444-4444-444444444444}"',
          "EndProject",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "platform/admission"), { recursive: true });
      await mkdir(path.join(repo, "platform/billing"), { recursive: true });
      await mkdir(path.join(repo, "kernel/Core.Domain.Kernel"), {
        recursive: true,
      });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path).sort()).toEqual([
        "kernel/Core.Domain.Kernel",
        "platform/admission",
        "platform/billing",
      ]);
    });

    test("does not coarsen a top-level src/Proj to the repository root", async () => {
      // A project directly under a root `src/` (no area segment above the `src`
      // parent) must NOT collapse to "" (the repo root); it stays at src/Proj.
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "App.sln"),
        [
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "src\\Api\\Api.csproj", "{11111111-1111-1111-1111-111111111111}"',
          "EndProject",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "src/Api"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path)).toEqual(["src/Api"]);
    });

    test("does not collapse an area named `src`/`tests` to a bare tree root", async () => {
      // BUG 1 guard: when the area segment above the src/tests parent is itself
      // `src` or `tests` (idiomatic: a tests folder directly under a top-level
      // src/), coarsening must NOT produce a bare `src`/`tests` workspace that
      // would span the entire source or test tree as one wiki.
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "App.sln"),
        [
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Tests", "src\\tests\\App.Tests\\App.Tests.csproj", "{11111111-1111-1111-1111-111111111111}"',
          "EndProject",
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Inner", "src\\src\\Foo\\Foo.csproj", "{22222222-2222-2222-2222-222222222222}"',
          "EndProject",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "src/tests/App.Tests"), { recursive: true });
      await mkdir(path.join(repo, "src/src/Foo"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      const paths = detected.map((entry) => entry.path);
      expect(paths).not.toContain("src");
      expect(paths).not.toContain("tests");
      expect(paths.sort()).toEqual(["src/src/Foo", "src/tests/App.Tests"]);
    });

    test("keeps a top-level src/App and its src/tests/App.Tests both alive", async () => {
      // BUG 2 guard: without the area!==src/tests check, `src/tests/App.Tests`
      // coarsens to `src`, becomes an ancestor of `src/App`, and dropAncestor
      // deletes it, silently losing the test project. Both must survive.
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "App.sln"),
        [
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"',
          "EndProject",
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Tests", "src\\tests\\App.Tests\\App.Tests.csproj", "{22222222-2222-2222-2222-222222222222}"',
          "EndProject",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "src/App"), { recursive: true });
      await mkdir(path.join(repo, "src/tests/App.Tests"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path).sort()).toEqual([
        "src/App",
        "src/tests/App.Tests",
      ]);
    });

    test("documented edge: a directly-in-area project is dropped when a deeper non-src/tests sibling keeps the area as an ancestor", async () => {
      // BUG 3 (accepted, documented): `area/Y` coarsens to nothing (its parent
      // `area` is not src/tests, so it stays `area/Y`)... but here `area/Api`
      // sits directly in the area via a src/ project that coarsens to `area`,
      // while `area/group/Z` (parent `group` != src/tests) stays granular. The
      // coarsened `area` becomes an ancestor of `area/group/Z` and is dropped.
      // This locks in the known behavior; the lost area is recoverable via the
      // written manifest.
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "App.sln"),
        [
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "area\\src\\Area.Api\\Area.Api.csproj", "{11111111-1111-1111-1111-111111111111}"',
          "EndProject",
          'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Deep", "area\\group\\Area.Deep\\Area.Deep.csproj", "{22222222-2222-2222-2222-222222222222}"',
          "EndProject",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "area/src/Area.Api"), { recursive: true });
      await mkdir(path.join(repo, "area/group/Area.Deep"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      // `area` (from area/src/Area.Api) is an ancestor of `area/group/Area.Deep`
      // and is dropped; only the deeper granular project survives.
      expect(detected.map((entry) => entry.path)).toEqual([
        "area/group/Area.Deep",
      ]);
    });
  });

  describe("Maven (pom.xml modules)", () => {
    test("expands <module> directories", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "pom.xml"),
        [
          '<project xmlns="http://maven.apache.org/POM/4.0.0">',
          "  <modules>",
          "    <module>service-a</module>",
          "    <module>libs/service-b</module>",
          "  </modules>",
          "</project>",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "service-a"), { recursive: true });
      await mkdir(path.join(repo, "libs/service-b"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path).sort()).toEqual([
        "libs/service-b",
        "service-a",
      ]);
    });

    test("ignores modules inside XML comments", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "pom.xml"),
        [
          "<project>",
          "  <modules>",
          "    <module>service-a</module>",
          "    <!-- <module>disabled</module> -->",
          "  </modules>",
          "</project>",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "service-a"), { recursive: true });
      await mkdir(path.join(repo, "disabled"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      const paths = detected.map((entry) => entry.path);
      expect(paths).toEqual(["service-a"]);
      expect(paths).not.toContain("disabled");
    });

    test("detects only the first (root) <modules> block", async () => {
      // Documented limitation: profile-scoped <modules> are not merged; the
      // narrow regex matches the first <modules> block only. Lock in that the
      // root modules are detected (profile modules are simply not added).
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "pom.xml"),
        [
          "<project>",
          "  <modules>",
          "    <module>always</module>",
          "  </modules>",
          "  <profiles>",
          "    <profile>",
          "      <modules>",
          "        <module>only-in-profile</module>",
          "      </modules>",
          "    </profile>",
          "  </profiles>",
          "</project>",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "always"), { recursive: true });
      await mkdir(path.join(repo, "only-in-profile"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path)).toEqual(["always"]);
    });

    test("malformed pom.xml returns no Maven workspaces", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "pom.xml"),
        "<project>no modules",
        "utf8",
      );
      expect(await detectWorkspaces(repo)).toEqual([]);
    });
  });

  describe("Gradle (settings.gradle / .kts includes)", () => {
    test("maps :foo:bar project paths to foo/bar (Groovy)", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "settings.gradle"),
        [
          "rootProject.name = 'demo'",
          "include ':app'",
          "include ':libs:core', ':libs:util'",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "app"), { recursive: true });
      await mkdir(path.join(repo, "libs/core"), { recursive: true });
      await mkdir(path.join(repo, "libs/util"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path).sort()).toEqual([
        "app",
        "libs/core",
        "libs/util",
      ]);
    });

    test("handles Kotlin include(...) form and merges both files", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "settings.gradle.kts"),
        ['include(":api", ":shared")', ""].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "api"), { recursive: true });
      await mkdir(path.join(repo, "shared"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path).sort()).toEqual([
        "api",
        "shared",
      ]);
    });

    test("captures a multi-line comma-continued include (Groovy)", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "settings.gradle"),
        ["include ':a',", "  ':b',", "  ':c'", ""].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "a"), { recursive: true });
      await mkdir(path.join(repo, "b"), { recursive: true });
      await mkdir(path.join(repo, "c"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path).sort()).toEqual([
        "a",
        "b",
        "c",
      ]);
    });

    test("captures a multi-line Kotlin include(...) list", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "settings.gradle.kts"),
        ["include(", '  ":api",', '  ":shared"', ")", ""].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "api"), { recursive: true });
      await mkdir(path.join(repo, "shared"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path).sort()).toEqual([
        "api",
        "shared",
      ]);
    });

    test("does not emit includeBuild composite builds", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "settings.gradle"),
        ["include ':app'", "includeBuild '../build-logic'", ""].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "app"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path)).toEqual(["app"]);
    });

    test("ignores includes in trailing and block comments", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "settings.gradle"),
        [
          "include ':app' // include ':trailingFake'",
          "/*",
          "include ':blockFake'",
          "*/",
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "app"), { recursive: true });
      await mkdir(path.join(repo, "trailingFake"), { recursive: true });
      await mkdir(path.join(repo, "blockFake"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      const paths = detected.map((entry) => entry.path);
      expect(paths).toEqual(["app"]);
      expect(paths).not.toContain("trailingFake");
      expect(paths).not.toContain("blockFake");
    });

    test("malformed settings.gradle returns no Gradle workspaces", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "settings.gradle"),
        "rootProject.name = 'demo'",
        "utf8",
      );
      expect(await detectWorkspaces(repo)).toEqual([]);
    });
  });

  describe("Python uv workspace (pyproject.toml)", () => {
    test("expands [tool.uv.workspace] members globs", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "pyproject.toml"),
        [
          "[project]",
          'name = "root"',
          "",
          "[tool.uv.workspace]",
          'members = ["packages/*", "tools/cli"]',
          'exclude = ["packages/seeds"]',
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(path.join(repo, "packages/a"), { recursive: true });
      await mkdir(path.join(repo, "packages/b"), { recursive: true });
      await mkdir(path.join(repo, "tools/cli"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path).sort()).toEqual([
        "packages/a",
        "packages/b",
        "tools/cli",
      ]);
    });

    test("pyproject.toml without a uv workspace section returns []", async () => {
      const repo = await createTempRepo();
      await writeFile(
        path.join(repo, "pyproject.toml"),
        '[project]\nname = "solo"\n',
        "utf8",
      );
      expect(await detectWorkspaces(repo)).toEqual([]);
    });
  });

  describe("Bazel (coarse top-level roots)", () => {
    test("emits immediate child dirs with a BUILD file when MODULE.bazel exists", async () => {
      const repo = await createTempRepo();
      await writeFile(path.join(repo, "MODULE.bazel"), "", "utf8");
      await mkdir(path.join(repo, "app"), { recursive: true });
      await writeFile(path.join(repo, "app/BUILD.bazel"), "", "utf8");
      await mkdir(path.join(repo, "lib"), { recursive: true });
      await writeFile(path.join(repo, "lib/BUILD"), "", "utf8");
      // A top-level dir with no BUILD file must not be emitted.
      await mkdir(path.join(repo, "docs"), { recursive: true });

      const detected = await detectWorkspaces(repo);
      const paths = detected.map((entry) => entry.path);
      expect(paths.sort()).toEqual(["app", "lib"]);
      expect(paths).not.toContain("docs");
    });

    test("does not explode into deeply nested Bazel packages", async () => {
      const repo = await createTempRepo();
      await writeFile(path.join(repo, "WORKSPACE"), "", "utf8");
      await mkdir(path.join(repo, "app/feature/impl"), { recursive: true });
      await writeFile(path.join(repo, "app/BUILD.bazel"), "", "utf8");
      // Nested BUILD files exist but must NOT each become a workspace.
      await writeFile(path.join(repo, "app/feature/BUILD.bazel"), "", "utf8");
      await writeFile(
        path.join(repo, "app/feature/impl/BUILD.bazel"),
        "",
        "utf8",
      );

      const detected = await detectWorkspaces(repo);
      expect(detected.map((entry) => entry.path)).toEqual(["app"]);
    });

    test("Bazel with no top-level BUILD dir returns []", async () => {
      const repo = await createTempRepo();
      await writeFile(path.join(repo, "MODULE.bazel"), "", "utf8");
      await mkdir(path.join(repo, "deep/nested/pkg"), { recursive: true });
      await writeFile(path.join(repo, "deep/nested/pkg/BUILD"), "", "utf8");

      expect(await detectWorkspaces(repo)).toEqual([]);
    });
  });
});

// Regression seam: detectWorkspaces output must feed resolveWorkspaceRuns
// without throwing. The overlap bug lived exactly here — every other overlap
// test hand-crafts the manifest, so this exercises the real auto-detect path.
describe("detectWorkspaces -> resolveWorkspaceRuns seam", () => {
  test("packages/** detection resolves without overlap errors", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ workspaces: ["packages/**"] }),
      "utf8",
    );
    await mkdir(path.join(repo, "packages/a"), { recursive: true });
    await writeFile(path.join(repo, "packages/a/package.json"), "{}", "utf8");
    await mkdir(path.join(repo, "packages/b/sub"), { recursive: true });
    await writeFile(
      path.join(repo, "packages/b/sub/package.json"),
      "{}",
      "utf8",
    );

    const detected = await detectWorkspaces(repo);
    // Must not throw (previously threw "packages is an ancestor of ...").
    const plan = resolveWorkspaceRuns(repo, {
      version: 1,
      workspaces: detected,
    });
    const relativePaths = plan.runs.map((run) => run.relativePath).sort();
    expect(relativePaths).toEqual(["packages/a", "packages/b/sub"]);
  });

  test(".NET .sln detection resolves without throwing", async () => {
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "App.sln"),
      [
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "src\\Api\\Api.csproj", "{11111111-1111-1111-1111-111111111111}"',
        "EndProject",
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Web", "src\\Web\\Web.csproj", "{22222222-2222-2222-2222-222222222222}"',
        "EndProject",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(path.join(repo, "src/Api"), { recursive: true });
    await mkdir(path.join(repo, "src/Web"), { recursive: true });

    const detected = await detectWorkspaces(repo);
    const plan = resolveWorkspaceRuns(repo, {
      version: 1,
      workspaces: detected,
    });
    expect(plan.runs.map((run) => run.relativePath).sort()).toEqual([
      "src/Api",
      "src/Web",
    ]);
  });

  test("coarsened .NET area detection resolves to product-area runs", async () => {
    // The DDD src/tests granularity would otherwise yield one run per .csproj;
    // detection must coarsen to area roots that resolve without overlap.
    const repo = await createTempRepo();
    await writeFile(
      path.join(repo, "App.sln"),
      [
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "platform\\admission\\src\\Core.Admission.Api\\Core.Admission.Api.csproj", "{11111111-1111-1111-1111-111111111111}"',
        "EndProject",
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Domain", "platform\\admission\\src\\Core.Admission.Domain\\Core.Admission.Domain.csproj", "{22222222-2222-2222-2222-222222222222}"',
        "EndProject",
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Tests", "platform\\admission\\tests\\Core.Admission.Domain.Tests\\Core.Admission.Domain.Tests.csproj", "{33333333-3333-3333-3333-333333333333}"',
        "EndProject",
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Kernel", "kernel\\Core.Domain.Kernel\\Core.Domain.Kernel.csproj", "{44444444-4444-4444-4444-444444444444}"',
        "EndProject",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(path.join(repo, "platform/admission"), { recursive: true });
    await mkdir(path.join(repo, "kernel/Core.Domain.Kernel"), {
      recursive: true,
    });

    const detected = await detectWorkspaces(repo);
    const plan = resolveWorkspaceRuns(repo, {
      version: 1,
      workspaces: detected,
    });
    expect(plan.runs.map((run) => run.relativePath).sort()).toEqual([
      "kernel/Core.Domain.Kernel",
      "platform/admission",
    ]);
  });
});

describe("writeGeneratedFile (symlink-following guard)", () => {
  test("writes a normal file inside the repo", async () => {
    const repo = await createTempRepo();
    const target = path.join(repo, "openwiki", "workspaces.md");
    await writeGeneratedFile(repo, target, "hello\n");
    expect(await readFile(target, "utf8")).toBe("hello\n");
  });

  test("refuses to follow a symlinked destination and does not clobber its target", async () => {
    const repo = await createTempRepo();
    const outside = await createTempRepo();
    const victim = path.join(outside, "victim.txt");
    await writeFile(victim, "original\n");

    // A malicious repo commits openwiki/workspaces.md as a symlink to a file
    // outside the repo; the write must refuse rather than follow it.
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    const link = path.join(repo, "openwiki", "workspaces.md");
    await symlink(victim, link);

    await expect(
      writeGeneratedFile(repo, link, "attacker content\n"),
    ).rejects.toThrow(/symlink/);
    // The link target outside the repo is untouched.
    expect(await readFile(victim, "utf8")).toBe("original\n");
    // The path on disk is still a symlink, never overwritten as a real file.
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  test("refuses when the parent directory resolves outside the repo", async () => {
    const repo = await createTempRepo();
    const outside = await createTempRepo();
    // openwiki/ itself is a symlink to a directory outside the repo, so the
    // resolved write parent escapes the repository.
    await symlink(outside, path.join(repo, "openwiki"));

    await expect(
      writeGeneratedFile(
        repo,
        path.join(repo, "openwiki", "workspaces.md"),
        "x\n",
      ),
    ).rejects.toThrow(/outside the repository/);
  });
});
