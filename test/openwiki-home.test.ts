import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  getOpenWikiHomeDisplayPath,
  OPENWIKI_CONFIG_DIR_ENV_KEY,
  resolveOpenWikiHomeDir,
} from "../src/config/openwiki-home.ts";

const originalConfigDir = process.env.OPENWIKI_CONFIG_DIR;

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.OPENWIKI_CONFIG_DIR;
  else process.env.OPENWIKI_CONFIG_DIR = originalConfigDir;
  vi.resetModules();
});

describe("resolveOpenWikiHomeDir", () => {
  test("uses the default directory when no override is configured", () => {
    expect(resolveOpenWikiHomeDir({})).toBe(
      path.join(os.homedir(), ".openwiki"),
    );
  });

  test("uses a configured directory for all local OpenWiki state", () => {
    expect(
      resolveOpenWikiHomeDir({
        [OPENWIKI_CONFIG_DIR_ENV_KEY]: "C:/openwiki-state",
      }),
    ).toBe(path.resolve("C:/openwiki-state"));
  });

  test("treats whitespace-only overrides as unset", () => {
    expect(
      resolveOpenWikiHomeDir({ [OPENWIKI_CONFIG_DIR_ENV_KEY]: "  " }),
    ).toBe(resolveOpenWikiHomeDir({}));
  });

  test("expands a bare ~ override to the home directory", () => {
    expect(resolveOpenWikiHomeDir({ [OPENWIKI_CONFIG_DIR_ENV_KEY]: "~" })).toBe(
      path.join(os.homedir()),
    );
  });

  test("expands a ~/-prefixed override relative to the home directory", () => {
    expect(
      resolveOpenWikiHomeDir({
        [OPENWIKI_CONFIG_DIR_ENV_KEY]: "~/openwiki-state",
      }),
    ).toBe(path.resolve(os.homedir(), "openwiki-state"));
  });

  test("expands a ~\\-prefixed override on Windows-style paths", () => {
    expect(
      resolveOpenWikiHomeDir({
        [OPENWIKI_CONFIG_DIR_ENV_KEY]: "~\\openwiki-state",
      }),
    ).toBe(path.resolve(os.homedir(), "openwiki-state"));
  });

  test("resolves a relative path against the current working directory", () => {
    expect(
      resolveOpenWikiHomeDir({
        [OPENWIKI_CONFIG_DIR_ENV_KEY]: "relative/path",
      }),
    ).toBe(path.resolve("relative/path"));
  });

  test("shares an override with credential storage", async () => {
    process.env.OPENWIKI_CONFIG_DIR = "C:/openwiki-state";
    vi.resetModules();

    const { openWikiHomeDir } = await import("../src/config/openwiki-home.ts");
    const { openWikiEnvDir, openWikiEnvPath } =
      await import("../src/config/env.ts");

    expect(openWikiEnvDir).toBe(openWikiHomeDir);
    expect(openWikiEnvPath).toBe(path.join(openWikiHomeDir, ".env"));
  });

  test("uses the configured path in agent instructions", async () => {
    process.env.OPENWIKI_CONFIG_DIR = "C:/openwiki-state";
    vi.resetModules();

    const { PERSONAL_SYSTEM_PROMPTS } =
      await import("../src/agent/prompts/personal.ts");

    expect(PERSONAL_SYSTEM_PROMPTS.chat).toContain(
      `${path.resolve("C:/openwiki-state")}/wiki`,
    );
  });

  test("initializes configured state without consulting the home directory", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "openwiki-config-dir-"),
    );
    const configuredDir = path.join(tempDir, "state");
    process.env.OPENWIKI_CONFIG_DIR = configuredDir;
    const homedirSpy = vi.spyOn(os, "homedir").mockImplementation(() => {
      throw new Error("home directory is unavailable");
    });
    vi.resetModules();

    try {
      const home = await import("../src/config/openwiki-home.ts");
      expect(home.openWikiHomeDir).toBe(configuredDir);

      await home.ensureOpenWikiHome();

      for (const directory of [
        home.openWikiHomeDir,
        home.openWikiConnectorsDir,
        home.openWikiConversationHistoryDir,
        home.openWikiLocalWikiDir,
        home.openWikiSkillsDir,
      ]) {
        expect((await stat(directory)).isDirectory()).toBe(true);
      }
      expect(homedirSpy).not.toHaveBeenCalled();
    } finally {
      homedirSpy.mockRestore();
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});

describe("getOpenWikiHomeDisplayPath", () => {
  test("returns ~/.openwiki when no override is configured", () => {
    expect(getOpenWikiHomeDisplayPath({})).toBe("~/.openwiki");
  });

  test("returns the resolved absolute path when a custom dir is configured", () => {
    const displayPath = getOpenWikiHomeDisplayPath({
      [OPENWIKI_CONFIG_DIR_ENV_KEY]: "C:/custom-wiki",
    });
    expect(displayPath).toBe(path.resolve("C:/custom-wiki"));
    expect(displayPath).not.toContain("~");
  });

  test("expands ~/ prefix in display path", () => {
    const displayPath = getOpenWikiHomeDisplayPath({
      [OPENWIKI_CONFIG_DIR_ENV_KEY]: "~/custom-wiki",
    });
    expect(displayPath).toBe(path.resolve(os.homedir(), "custom-wiki"));
  });
});

describe("display-path derivations", () => {
  test("env display path appends .env to display path", async () => {
    process.env.OPENWIKI_CONFIG_DIR = "C:/custom-state";
    vi.resetModules();

    const home = await import("../src/config/openwiki-home.ts");

    expect(home.openWikiEnvDisplayPath).toBe(
      `${path.resolve("C:/custom-state")}/.env`,
    );
  });

  test("connectors display path appends /connectors to display path", async () => {
    process.env.OPENWIKI_CONFIG_DIR = "C:/custom-state";
    vi.resetModules();

    const home = await import("../src/config/openwiki-home.ts");

    expect(home.openWikiConnectorsDisplayPath).toBe(
      `${path.resolve("C:/custom-state")}/connectors`,
    );
  });

  test("wiki display path appends /wiki to display path", async () => {
    process.env.OPENWIKI_CONFIG_DIR = "C:/custom-state";
    vi.resetModules();

    const home = await import("../src/config/openwiki-home.ts");

    expect(home.openWikiLocalWikiDisplayPath).toBe(
      `${path.resolve("C:/custom-state")}/wiki`,
    );
  });

  test("skills display path appends /skills to display path", async () => {
    process.env.OPENWIKI_CONFIG_DIR = "C:/custom-state";
    vi.resetModules();

    const home = await import("../src/config/openwiki-home.ts");

    expect(home.openWikiSkillsDisplayPath).toBe(
      `${path.resolve("C:/custom-state")}/skills`,
    );
  });

  test("default display paths use ~/.openwiki prefix", async () => {
    vi.resetModules();

    const home = await import("../src/config/openwiki-home.ts");

    expect(home.openWikiEnvDisplayPath).toBe("~/.openwiki/.env");
    expect(home.openWikiConnectorsDisplayPath).toBe("~/.openwiki/connectors");
    expect(home.openWikiLocalWikiDisplayPath).toBe("~/.openwiki/wiki");
    expect(home.openWikiSkillsDisplayPath).toBe("~/.openwiki/skills");
    expect(home.openWikiHomeDisplayPath).toBe("~/.openwiki");
  });

  test("connector statePath uses display path for custom config dir", async () => {
    process.env.OPENWIKI_CONFIG_DIR = "C:/custom-state";
    vi.resetModules();

    const home = await import("../src/config/openwiki-home.ts");

    const statePath = home.getConnectorStatePath("x");
    expect(statePath).toBe(
      path.join(
        path.resolve("C:/custom-state"),
        "connectors",
        "x",
        "state.json",
      ),
    );
  });
});
