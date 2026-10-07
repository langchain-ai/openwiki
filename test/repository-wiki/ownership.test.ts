import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { inspectRepositoryWikiOwnership } from "../../src/repository-wiki/ownership.ts";

async function repositoryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "openwiki-ownership-"));
}

describe("repository wiki ownership", () => {
  test("classifies absent and empty targets", async () => {
    const root = await repositoryRoot();
    await expect(
      inspectRepositoryWikiOwnership(root, "docs/wiki"),
    ).resolves.toEqual({ status: "absent" });

    await mkdir(path.join(root, "docs", "wiki"), { recursive: true });
    await expect(
      inspectRepositoryWikiOwnership(root, "docs/wiki"),
    ).resolves.toEqual({ status: "empty" });
  });

  test("permits one regular INSTRUCTIONS.md brief", async () => {
    const root = await repositoryRoot();
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "INSTRUCTIONS.md"), "# Brief\n");
    await expect(inspectRepositoryWikiOwnership(root, "docs")).resolves.toEqual(
      { status: "instructions-only" },
    );
  });

  test.each([
    [".last-update.json", "file"],
    [".page-manifest.json", "file"],
    [".run.json", "file"],
    [".claims", "directory"],
  ] as const)("recognizes the %s ownership marker", async (marker, kind) => {
    const root = await repositoryRoot();
    const wiki = path.join(root, "docs");
    await mkdir(wiki);
    if (kind === "file") await writeFile(path.join(wiki, marker), "{}\n");
    else await mkdir(path.join(wiki, marker));
    await writeFile(path.join(wiki, "page.md"), "# Page\n");

    await expect(inspectRepositoryWikiOwnership(root, "docs")).resolves.toEqual(
      { status: "managed", markers: [marker] },
    );
  });

  test("returns all recognized markers in stable order", async () => {
    const root = await repositoryRoot();
    const wiki = path.join(root, "docs");
    await mkdir(path.join(wiki, ".claims"), { recursive: true });
    await writeFile(path.join(wiki, ".run.json"), "{}\n");
    await writeFile(path.join(wiki, ".last-update.json"), "{}\n");
    await expect(inspectRepositoryWikiOwnership(root, "docs")).resolves.toEqual(
      {
        status: "managed",
        markers: [".claims", ".last-update.json", ".run.json"],
      },
    );
  });

  test("classifies ordinary non-empty directories as unmanaged", async () => {
    const root = await repositoryRoot();
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "README.md"), "# Existing docs\n");
    await expect(inspectRepositoryWikiOwnership(root, "docs")).resolves.toEqual(
      { status: "unmanaged", entryCount: 1 },
    );
  });

  test("rejects a symlinked target or parent component", async () => {
    const targetRoot = await repositoryRoot();
    const outside = await repositoryRoot();
    await symlink(outside, path.join(targetRoot, "docs"));
    const target = await inspectRepositoryWikiOwnership(targetRoot, "docs");
    expect(target.status).toBe("unsafe");
    expect(target.status === "unsafe" ? target.reason : "").toContain(
      "symbolic links",
    );

    const parentRoot = await repositoryRoot();
    await symlink(outside, path.join(parentRoot, "linked"));
    const parent = await inspectRepositoryWikiOwnership(
      parentRoot,
      "linked/wiki",
    );
    expect(parent.status).toBe("unsafe");
    expect(parent.status === "unsafe" ? parent.reason : "").toContain(
      "symbolic links",
    );
  });

  test("rejects non-directory targets and parent components", async () => {
    const targetRoot = await repositoryRoot();
    await writeFile(path.join(targetRoot, "docs"), "not a directory\n");
    await expect(
      inspectRepositoryWikiOwnership(targetRoot, "docs"),
    ).resolves.toMatchObject({
      status: "unsafe",
      reason: "Repository wiki target must be a directory",
    });

    const parentRoot = await repositoryRoot();
    await writeFile(path.join(parentRoot, "docs"), "not a directory\n");
    await expect(
      inspectRepositoryWikiOwnership(parentRoot, "docs/wiki"),
    ).resolves.toMatchObject({
      status: "unsafe",
      reason: "Repository wiki parent path must be a directory",
    });
  });

  test("rejects symlinked or malformed ownership markers", async () => {
    const symlinkRoot = await repositoryRoot();
    await mkdir(path.join(symlinkRoot, "docs"));
    await writeFile(path.join(symlinkRoot, "marker.json"), "{}\n");
    await symlink(
      path.join(symlinkRoot, "marker.json"),
      path.join(symlinkRoot, "docs", ".run.json"),
    );
    const symlinked = await inspectRepositoryWikiOwnership(symlinkRoot, "docs");
    expect(symlinked.status).toBe("unsafe");
    expect(symlinked.status === "unsafe" ? symlinked.reason : "").toContain(
      "cannot be a symbolic link",
    );

    const malformedRoot = await repositoryRoot();
    await mkdir(path.join(malformedRoot, "docs", ".run.json"), {
      recursive: true,
    });
    const malformed = await inspectRepositoryWikiOwnership(
      malformedRoot,
      "docs",
    );
    expect(malformed.status).toBe("unsafe");
    expect(malformed.status === "unsafe" ? malformed.reason : "").toContain(
      "unexpected file type",
    );
  });

  test("rejects a symlinked INSTRUCTIONS.md brief", async () => {
    const root = await repositoryRoot();
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "brief.md"), "# Brief\n");
    await symlink("../brief.md", path.join(root, "docs", "INSTRUCTIONS.md"));
    const ownership = await inspectRepositoryWikiOwnership(root, "docs");
    expect(ownership.status).toBe("unsafe");
    expect(ownership.status === "unsafe" ? ownership.reason : "").toContain(
      "regular file",
    );
  });
});
