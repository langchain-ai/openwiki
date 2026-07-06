import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, beforeAll } from "vitest";
import { createOpenWikiContentSnapshot } from "../src/agent/utils.ts";

let canSymlink = false;

beforeAll(async () => {
  // Test if symlinks are supported (requires elevated privileges on Windows)
  const testDir = await mkdtemp(path.join(tmpdir(), "openwiki-symlink-test-"));
  try {
    await symlink("target", path.join(testDir, "link"));
    canSymlink = true;
  } catch {
    canSymlink = false;
  }
});

describe("createOpenWikiContentSnapshot with symlink cycles", () => {
  test("handles a direct symlink cycle without crashing", async () => {
    if (!canSymlink) {
      return;
    }

    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-symlink-"));
    const openwikiDir = path.join(cwd, "openwiki");
    await mkdir(openwikiDir, { recursive: true });
    await writeFile(
      path.join(openwikiDir, "quickstart.md"),
      "# Quickstart\n",
      "utf8",
    );

    // Create a symlink cycle: openwiki/link -> openwiki
    await symlink(openwikiDir, path.join(openwikiDir, "link"));

    // Should not throw ELOOP
    const hash = await createOpenWikiContentSnapshot(cwd);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  test("handles a multi-hop symlink cycle without crashing", async () => {
    if (!canSymlink) {
      return;
    }

    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-symlink-"));
    const openwikiDir = path.join(cwd, "openwiki");
    const subdir = path.join(openwikiDir, "sub");
    await mkdir(subdir, { recursive: true });
    await writeFile(
      path.join(openwikiDir, "quickstart.md"),
      "# Quickstart\n",
      "utf8",
    );
    await writeFile(path.join(subdir, "file.md"), "# File\n", "utf8");

    // Create a multi-hop cycle: sub/link -> openwiki (back to root)
    await symlink(openwikiDir, path.join(subdir, "link"));

    const hash = await createOpenWikiContentSnapshot(cwd);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  test("handles a dangling symlink without crashing", async () => {
    if (!canSymlink) {
      return;
    }

    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-symlink-"));
    const openwikiDir = path.join(cwd, "openwiki");
    await mkdir(openwikiDir, { recursive: true });
    await writeFile(
      path.join(openwikiDir, "quickstart.md"),
      "# Quickstart\n",
      "utf8",
    );

    // Create a symlink to a non-existent target
    await symlink("/nonexistent/path", path.join(openwikiDir, "broken-link"));

    const hash = await createOpenWikiContentSnapshot(cwd);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  test("handles a valid symlink to a directory without crashing", async () => {
    if (!canSymlink) {
      return;
    }

    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-symlink-"));
    const openwikiDir = path.join(cwd, "openwiki");
    const externalDir = path.join(cwd, "external");
    await mkdir(openwikiDir, { recursive: true });
    await mkdir(externalDir, { recursive: true });
    await writeFile(
      path.join(openwikiDir, "quickstart.md"),
      "# Quickstart\n",
      "utf8",
    );
    await writeFile(
      path.join(externalDir, "external.md"),
      "# External\n",
      "utf8",
    );

    // Create a valid symlink to an external directory (not a cycle)
    await symlink(externalDir, path.join(openwikiDir, "ext-link"));

    const hash = await createOpenWikiContentSnapshot(cwd);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  test("traverses normal directory structure correctly", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-symlink-"));
    const openwikiDir = path.join(cwd, "openwiki");
    const subDir = path.join(openwikiDir, "sub");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      path.join(openwikiDir, "quickstart.md"),
      "# Quickstart\n",
      "utf8",
    );
    await writeFile(path.join(subDir, "page.md"), "# Page\n", "utf8");

    const hash = await createOpenWikiContentSnapshot(cwd);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });
});
