import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Delegate every fs/promises call to the real implementation so the home layout
// and its permission modes are exercised for real, but keep `chmod` swappable so
// the TOCTOU catch inside `chmodIfExists` (unreachable on the happy path, since
// the directory always exists right after mkdir) can be driven deterministically.
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: vi.fn((...args: Parameters<typeof actual.chmod>) =>
      actual.chmod(...args),
    ),
  };
});

const OWNER_ONLY_DIR = 0o700;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

let savedHome: string | undefined;
let tempHome: string;
let fsp: typeof import("node:fs/promises");
let home: typeof import("../../src/config/openwiki-home.ts");

beforeEach(async () => {
  savedHome = process.env.HOME;
  // `os.homedir()` re-reads $HOME at runtime, so pointing it at a throwaway
  // directory and re-importing the module reroutes the whole ~/.openwiki tree
  // away from the developer's real home.
  const base = await (
    await import("node:fs/promises")
  ).mkdtemp(path.join(os.tmpdir(), "openwiki-home-"));
  tempHome = base;
  process.env.HOME = tempHome;

  vi.resetModules();
  fsp = await import("node:fs/promises");
  vi.mocked(fsp.chmod).mockClear();
  home = await import("../../src/config/openwiki-home.ts");
});

afterEach(async () => {
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
  await fsp.rm(tempHome, { recursive: true, force: true });
});

async function mode(dirPath: string): Promise<number> {
  return (await fsp.stat(dirPath)).mode & 0o777;
}

describe("ensureOpenWikiHome", () => {
  test("creates the home tree owner-only (0700) and hardens the root", async () => {
    await home.ensureOpenWikiHome();

    // Permission-mode enforcement: the id/credential store must not be group or
    // world readable, so every directory lands at 0700.
    for (const dir of [
      home.openWikiHomeDir,
      home.openWikiConnectorsDir,
      home.openWikiLocalWikiDir,
      home.openWikiSkillsDir,
    ]) {
      expect(await mode(dir)).toBe(OWNER_ONLY_DIR);
    }
    // The root is explicitly re-chmodded so a pre-existing loose directory is
    // tightened rather than left at whatever mode it had.
    expect(vi.mocked(fsp.chmod)).toHaveBeenCalledWith(
      home.openWikiHomeDir,
      OWNER_ONLY_DIR,
    );
  });

  test("is idempotent when the home already exists", async () => {
    await home.ensureOpenWikiHome();
    // The already-exists branch: a second run must not throw and must leave the
    // owner-only mode intact.
    await expect(home.ensureOpenWikiHome()).resolves.toBeUndefined();
    expect(await mode(home.openWikiHomeDir)).toBe(OWNER_ONLY_DIR);
  });

  test("rethrows a non-ENOENT chmod failure", async () => {
    // A permission error on chmod is a real problem, not the tolerated race, so
    // it must surface rather than be swallowed.
    vi.mocked(fsp.chmod).mockRejectedValueOnce(errno("EACCES"));

    await expect(home.ensureOpenWikiHome()).rejects.toThrow(/EACCES/u);
  });

  test("tolerates an ENOENT chmod race and keeps building the tree", async () => {
    // If the root vanished between mkdir and chmod, the chmod ENOENT is ignored
    // and the remaining subdirectories are still created.
    vi.mocked(fsp.chmod).mockRejectedValueOnce(errno("ENOENT"));

    await expect(home.ensureOpenWikiHome()).resolves.toBeUndefined();
    expect(await mode(home.openWikiConnectorsDir)).toBe(OWNER_ONLY_DIR);
  });
});

describe("ensureConnectorHome", () => {
  test("creates the connector dir, raw, and logs owner-only", async () => {
    await home.ensureConnectorHome("notion");

    for (const dir of [
      home.getConnectorDir("notion"),
      home.getConnectorRawDir("notion"),
      home.getConnectorLogsDir("notion"),
    ]) {
      expect(await mode(dir)).toBe(OWNER_ONLY_DIR);
    }
  });

  test("rejects an unsafe connector id before touching the filesystem", async () => {
    await expect(home.ensureConnectorHome("../escape")).rejects.toThrow(
      /Invalid connector ID/u,
    );
  });
});

describe("path helpers", () => {
  test("derive connector file paths under the connector directory", () => {
    const dir = home.getConnectorDir("notion");
    expect(home.getConnectorConfigPath("notion")).toBe(
      path.join(dir, "config.json"),
    );
    expect(home.getConnectorStatePath("notion")).toBe(
      path.join(dir, "state.json"),
    );
  });
});

describe("assertSafeConnectorId", () => {
  test("accepts a well-formed id and rejects malformed ones", () => {
    expect(() => home.assertSafeConnectorId("web-search")).not.toThrow();
    // Uppercase, leading digit/dash, path separators, and over-length ids are
    // all rejected so a connector id can never escape its directory.
    for (const bad of [
      "Notion",
      "-lead",
      "1lead",
      "../escape",
      "a".repeat(65),
      "",
    ]) {
      expect(() => home.assertSafeConnectorId(bad)).toThrow(
        /Invalid connector ID/u,
      );
    }
  });
});

describe("resolveConnectorRawPath", () => {
  test("resolves a path that stays inside the raw directory", () => {
    const resolved = home.resolveConnectorRawPath("notion", "items/a.json");
    expect(resolved).toBe(
      path.join(home.getConnectorRawDir("notion"), "items", "a.json"),
    );
  });

  test("rejects a relative path that escapes the raw directory", () => {
    // Path-traversal guard: a raw item path must never resolve outside the
    // connector's own raw directory.
    expect(() =>
      home.resolveConnectorRawPath("notion", "../../etc/passwd"),
    ).toThrow(/must stay inside/u);
  });
});
