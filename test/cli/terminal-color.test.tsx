import React from "react";
import chalk from "chalk";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CredentialDiagnosticsPanel } from "../../src/cli/components/panels.tsx";
import {
  declaresColorSupport,
  stabilizeColorLevel,
} from "../../src/cli/terminal-color.ts";
import type { CredentialDiagnostic } from "../../src/config/env.ts";

describe("declaresColorSupport", () => {
  test("treats unset, empty, and dumb variables as no declared support", () => {
    expect(declaresColorSupport({})).toBe(false);
    expect(declaresColorSupport({ TERM: "", COLORTERM: "" })).toBe(false);
    expect(declaresColorSupport({ TERM: "  " })).toBe(false);
    expect(declaresColorSupport({ TERM: "dumb" })).toBe(false);
    expect(declaresColorSupport({ COLORTERM: "" })).toBe(false);
  });

  test("accepts a declared terminal or a forced color", () => {
    expect(declaresColorSupport({ TERM: "xterm-256color" })).toBe(true);
    expect(declaresColorSupport({ COLORTERM: "truecolor" })).toBe(true);
    expect(declaresColorSupport({ FORCE_COLOR: "1" })).toBe(true);
  });

  test("keeps the standard precedence between FORCE_COLOR and NO_COLOR", () => {
    expect(declaresColorSupport({ FORCE_COLOR: "1", NO_COLOR: "1" })).toBe(
      true,
    );
    expect(
      declaresColorSupport({ NO_COLOR: "1", TERM: "xterm-256color" }),
    ).toBe(false);
    expect(declaresColorSupport({ NO_COLOR: "", TERM: "xterm-256color" })).toBe(
      true,
    );
  });
});

describe("stabilizeColorLevel", () => {
  let savedLevel: number;

  beforeEach(() => {
    savedLevel = chalk.level;
  });

  afterEach(() => {
    chalk.level = savedLevel;
  });

  test("pins plain output when the environment declares no color support", () => {
    chalk.level = 1;

    stabilizeColorLevel({ TERM: "", COLORTERM: "" });

    expect(chalk.level).toBe(0);
  });

  test("keeps the detected level when TERM declares color support", () => {
    chalk.level = 1;

    stabilizeColorLevel({ TERM: "xterm-256color" });

    expect(chalk.level).toBe(1);
  });
});

const diagnosticsFixture = (): CredentialDiagnostic[] => [
  {
    key: "OPENAI_API_KEY",
    source: "unset",
    length: null,
    preview: "",
    warnings: [],
  },
];

describe("muted text rendering under the color policy", () => {
  let savedLevel: number;

  beforeEach(() => {
    savedLevel = chalk.level;
    // Simulate a terminal that renders color, so the frame shows exactly what
    // the policy lets through.
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = savedLevel;
  });

  test("keeps gray secondary text when the environment declares color", () => {
    stabilizeColorLevel({ TERM: "xterm-256color" });

    const { lastFrame } = render(
      <CredentialDiagnosticsPanel diagnostics={diagnosticsFixture()} />,
    );

    expect(lastFrame()).toContain("\u001b[90m");
  });

  test("renders the same panel without escape codes when declarations are empty", () => {
    stabilizeColorLevel({ TERM: "", COLORTERM: "" });

    const { lastFrame } = render(
      <CredentialDiagnosticsPanel diagnostics={diagnosticsFixture()} />,
    );
    const frame = lastFrame() ?? "";

    expect(frame).not.toContain("\u001b[");
    expect(frame).toContain("Raw secret values are intentionally not printed.");
  });
});
