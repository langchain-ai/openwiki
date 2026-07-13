import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  OPENWIKI_CONFIG_DIR_ENV_KEY,
  resolveOpenWikiHomeDir,
} from "../src/openwiki-home.ts";

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

  test("shares an override with credential storage", async () => {
    process.env.OPENWIKI_CONFIG_DIR = "C:/openwiki-state";
    vi.resetModules();

    const { openWikiHomeDir } = await import("../src/openwiki-home.ts");
    const { openWikiEnvDir, openWikiEnvPath } = await import("../src/env.ts");

    expect(openWikiEnvDir).toBe(openWikiHomeDir);
    expect(openWikiEnvPath).toBe(path.join(openWikiHomeDir, ".env"));
  });

  test("uses the configured path in agent instructions", async () => {
    process.env.OPENWIKI_CONFIG_DIR = "C:/openwiki-state";
    vi.resetModules();

    const { createSystemPrompt } = await import("../src/agent/prompt.ts");

    expect(createSystemPrompt("chat")).toContain(
      `${path.resolve("C:/openwiki-state")}/wiki`,
    );
  });
});
