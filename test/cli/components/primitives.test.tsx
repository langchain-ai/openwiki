import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, test } from "vitest";
import {
  InputCursor,
  MenuRow,
  Panel,
  PromptBlock,
  Rows,
  StatusLine,
} from "../../../src/cli/components/primitives.tsx";
import { stripAnsi as plain } from "./ansi.ts";

describe("Panel", () => {
  test("renders a #-prefixed title above its children", () => {
    const { lastFrame } = render(
      <Panel title="Usage">
        <Rows rows={[{ label: "init", description: "start a run" }]} />
      </Panel>,
    );

    const frame = plain(lastFrame());
    expect(frame).toContain("# Usage");
    expect(frame).toContain("init");
    expect(frame).toContain("start a run");
  });
});

describe("Rows", () => {
  test("pads labels to a common width", () => {
    const { lastFrame } = render(
      <Rows
        rows={[
          { label: "a", description: "first" },
          { label: "longlabel", description: "second" },
        ]}
      />,
    );

    const frame = plain(lastFrame());
    // The short label is padded to the widest label's width, so its
    // description starts at the same column as the long label's.
    const firstLine = frame.split("\n").find((line) => line.includes("first"));
    const secondLine = frame
      .split("\n")
      .find((line) => line.includes("second"));
    expect(firstLine?.indexOf("first")).toBe(secondLine?.indexOf("second"));
  });
});

describe("StatusLine", () => {
  test("renders the label and value with a bullet marker", () => {
    const { lastFrame } = render(
      <StatusLine tone="success" label="Model" value="opus" />,
    );

    const frame = plain(lastFrame());
    expect(frame).toContain("* Model opus");
  });

  test.each(["success", "error", "active", "muted"] as const)(
    "renders the %s tone text",
    (tone) => {
      const { lastFrame } = render(
        <StatusLine tone={tone} label="L" value="V" />,
      );
      expect(plain(lastFrame())).toContain("L V");
    },
  );
});

describe("MenuRow", () => {
  test("marks the selected row with a > and pads the label", () => {
    const { lastFrame } = render(
      <MenuRow description="switch model" isSelected label="/model" />,
    );

    const frame = plain(lastFrame());
    expect(frame).toContain("> /model");
    expect(frame).toContain("switch model");
  });

  test("renders an unselected row without the > marker", () => {
    const { lastFrame } = render(
      <MenuRow description="d" isSelected={false} label="/help" />,
    );

    const frame = plain(lastFrame());
    expect(frame).not.toContain(">");
    expect(frame).toContain("/help");
  });
});

describe("InputCursor", () => {
  test("renders the caret glyph", () => {
    const { lastFrame } = render(<InputCursor />);
    expect(plain(lastFrame())).toBe("|");
  });
});

describe("PromptBlock", () => {
  test("echoes the message behind a > marker", () => {
    const { lastFrame } = render(<PromptBlock message="document the parser" />);
    const frame = plain(lastFrame());
    expect(frame).toContain(">");
    expect(frame).toContain("document the parser");
  });
});
