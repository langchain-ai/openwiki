import { afterEach, describe, expect, test } from "vitest";
import {
  formatCount,
  formatCwd,
  getDisplayModelId,
  isExitMessage,
} from "../../src/cli/format.ts";
import {
  getDefaultModelId,
  OPENWIKI_MODEL_ID_ENV_KEY,
  resolveConfiguredProvider,
} from "../../src/config/constants.ts";

describe("formatCount", () => {
  test("selects the singular noun only for one", () => {
    expect(formatCount(1, "task", "tasks")).toBe("1 task");
    expect(formatCount(2, "task", "tasks")).toBe("2 tasks");
  });
});

describe("isExitMessage", () => {
  test("matches /exit ignoring whitespace and case", () => {
    expect(isExitMessage("/exit")).toBe(true);
    expect(isExitMessage("  /EXIT  ")).toBe(true);
    expect(isExitMessage("/Exit")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isExitMessage("/exits")).toBe(false);
    expect(isExitMessage("exit")).toBe(false);
    expect(isExitMessage("")).toBe(false);
  });
});

describe("formatCwd", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  test("abbreviates a path under the home directory", () => {
    process.env.HOME = "/Users/example";

    expect(formatCwd("/Users/example/dev/openwiki")).toBe("~/dev/openwiki");
  });

  test("leaves paths outside the home directory unchanged", () => {
    process.env.HOME = "/Users/example";

    expect(formatCwd("/var/log")).toBe("/var/log");
  });

  test("returns the path unchanged when HOME is unset", () => {
    delete process.env.HOME;

    expect(formatCwd("/Users/example/dev")).toBe("/Users/example/dev");
  });
});

describe("getDisplayModelId", () => {
  const originalModelId = process.env[OPENWIKI_MODEL_ID_ENV_KEY];

  afterEach(() => {
    if (originalModelId === undefined) {
      delete process.env[OPENWIKI_MODEL_ID_ENV_KEY];
    } else {
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] = originalModelId;
    }
  });

  test("prefers an explicit model id", () => {
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] = "env-model";

    expect(getDisplayModelId("explicit-model")).toBe("explicit-model");
  });

  test("falls back to the env override when no explicit id is given", () => {
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] = "env-model";

    expect(getDisplayModelId(null)).toBe("env-model");
  });

  test("falls back to the configured provider default when nothing is set", () => {
    delete process.env[OPENWIKI_MODEL_ID_ENV_KEY];

    expect(getDisplayModelId(null)).toBe(
      getDefaultModelId(resolveConfiguredProvider()),
    );
  });
});
