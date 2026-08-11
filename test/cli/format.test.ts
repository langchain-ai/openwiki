import { afterEach, describe, expect, test } from "vitest";
import {
  formatCwd,
  getDisplayModelId,
  getSpinnerFrame,
  isExitMessage,
  truncateLogOutput,
  truncateToDisplayLines,
} from "../../src/cli/format.ts";
import {
  getDefaultModelId,
  OPENWIKI_MODEL_ID_ENV_KEY,
  resolveConfiguredProvider,
} from "../../src/config/constants.ts";

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

describe("truncateToDisplayLines", () => {
  test("collapses whitespace and returns short content unchanged", () => {
    expect(truncateToDisplayLines("a   b\n\tc", 2, 80)).toBe("a b c");
  });

  test("wraps to at most maxLines and marks the tail with an ellipsis", () => {
    const result = truncateToDisplayLines("abcdefghij", 2, 4);

    const lines = result.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe("abcd");
    expect(lines[1].endsWith("...")).toBe(true);
  });

  test("does not add an ellipsis when everything fits within the lines", () => {
    const result = truncateToDisplayLines("abcdefgh", 2, 4);

    expect(result).toBe("abcd\nefgh");
  });
});

describe("truncateLogOutput", () => {
  test("keeps short output on a single line", () => {
    expect(truncateLogOutput("hello world", "label")).toBe("hello world");
  });

  test("truncates long output to two display lines", () => {
    const content = "x".repeat(500);

    const result = truncateLogOutput(content, "label");
    expect(result.split("\n").length).toBeLessThanOrEqual(2);
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

describe("getSpinnerFrame", () => {
  test("cycles through the four frames", () => {
    expect(getSpinnerFrame(0)).toBe("-");
    expect(getSpinnerFrame(1)).toBe("\\");
    expect(getSpinnerFrame(2)).toBe("|");
    expect(getSpinnerFrame(3)).toBe("/");
    expect(getSpinnerFrame(4)).toBe("-");
  });
});
