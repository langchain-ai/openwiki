import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, test } from "vitest";
import {
  FIRST_RUN_NOTICE_WIDTH,
  FirstRunNotice,
  renderFirstRunNoticeText,
  wrapText,
} from "../../../src/cli/components/first-run-notice.tsx";
import { FIRST_RUN_NOTICE_BODY } from "../../../src/telemetry/index.ts";
import { stripAnsi as plain } from "./ansi.ts";

describe("wrapText", () => {
  test("wraps to the width without splitting words or exceeding it", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const lines = wrapText(text, 15);

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(15);
    }
    // Every original word survives, in order.
    expect(lines.join(" ").split(/\s+/u)).toEqual(text.split(/\s+/u));
  });

  test("keeps a single over-width word on its own line", () => {
    const lines = wrapText("supercalifragilistic short", 10);
    expect(lines[0]).toBe("supercalifragilistic");
  });
});

describe("renderFirstRunNoticeText", () => {
  test("plain form has no ANSI escapes and includes the body copy", () => {
    const esc = String.fromCharCode(27);
    const text = renderFirstRunNoticeText(false);

    expect(text).not.toContain(esc);
    expect(text).toContain("OpenWiki telemetry");
  });

  test("color form wraps the block in a gray SGR pair", () => {
    const esc = String.fromCharCode(27);
    const text = renderFirstRunNoticeText(true);

    expect(text.startsWith(`${esc}[90m`)).toBe(true);
    expect(text.endsWith(`${esc}[39m`)).toBe(true);
  });

  test("wraps body lines to the fixed notice width", () => {
    const lines = renderFirstRunNoticeText(false).split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(FIRST_RUN_NOTICE_WIDTH);
    }
  });
});

describe("FirstRunNotice", () => {
  test("renders the telemetry heading and body copy in a box", () => {
    const { lastFrame } = render(<FirstRunNotice />);
    const frame = plain(lastFrame());

    expect(frame).toContain("OpenWiki");
    expect(frame).toContain("telemetry");
    // The body copy is single-sourced from telemetry/config.
    expect(frame).toContain(FIRST_RUN_NOTICE_BODY.slice(0, 20));
  });
});
