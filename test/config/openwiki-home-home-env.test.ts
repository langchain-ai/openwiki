import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// On Windows `os.homedir()` reads `USERPROFILE`/`HOMEDRIVE+HOMEPATH` and
// silently ignores `process.env.HOME`. The onboarding and home-layout tests
// (and the CLI's test isolation) point `process.env.HOME` at a throwaway
// directory to keep the real `~/.openwiki` untouched. If `resolveOpenWikiHomeDir`
// ignores `$HOME`, that isolation is a no-op on Windows and tests corrupt the
// developer's real home (see issue #695). These tests prove the resolution
// honors `process.env.HOME` and only falls back to `os.homedir()` when `$HOME`
// is unset.
const FAKE_WINDOWS_HOME = "C:\\Users\\real-user";

let savedHome: string | undefined;
let tempHome: string;
let fsp: typeof import("node:fs/promises");
let home: typeof import("../../src/config/openwiki-home.ts");

beforeEach(async () => {
  savedHome = process.env.HOME;
  const base = await (
    await import("node:fs/promises")
  ).mkdtemp(path.join(os.tmpdir(), "openwiki-home-env-"));
  tempHome = base;
  process.env.HOME = tempHome;

  vi.resetModules();
  fsp = await import("node:fs/promises");
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

describe("resolveUserHomeDir honors process.env.HOME", () => {
  test("returns $HOME when it is set", () => {
    const resolved = home.resolveUserHomeDir({ HOME: tempHome });
    expect(resolved).toBe(path.resolve(tempHome));
    expect(resolved).not.toBe(FAKE_WINDOWS_HOME);
  });

  test("falls back to os.homedir() when $HOME is unset", () => {
    const resolved = home.resolveUserHomeDir({});
    expect(resolved).toBe(os.homedir());
    expect(resolved).not.toBe(path.resolve(tempHome));
  });
});

describe("resolveOpenWikiHomeDir honors process.env.HOME", () => {
  test("places .openwiki under $HOME, not under os.homedir()", () => {
    const resolved = home.resolveOpenWikiHomeDir({ HOME: tempHome });
    expect(resolved).toBe(path.join(path.resolve(tempHome), ".openwiki"));
    expect(resolved.startsWith(FAKE_WINDOWS_HOME)).toBe(false);
  });

  test("expands a bare ~ against $HOME", () => {
    const resolved = home.resolveOpenWikiHomeDir({
      HOME: tempHome,
      OPENWIKI_CONFIG_DIR: "~",
    });
    expect(resolved).toBe(path.resolve(tempHome));
    expect(resolved.startsWith(FAKE_WINDOWS_HOME)).toBe(false);
  });

  test("expands ~/ against $HOME", () => {
    const resolved = home.resolveOpenWikiHomeDir({
      HOME: tempHome,
      OPENWIKI_CONFIG_DIR: "~/wiki",
    });
    expect(resolved).toBe(path.resolve(tempHome, "wiki"));
    expect(resolved.startsWith(FAKE_WINDOWS_HOME)).toBe(false);
  });
});
