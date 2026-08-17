import React from "react";
import { Box, Text } from "ink";
import {
  FIRST_RUN_NOTICE_BODY,
  FIRST_RUN_NOTICE_OPT_OUT,
  FIRST_RUN_NOTICE_VERIFY,
} from "../../telemetry/index.js";

/** Frame/wrap width for the plain-text (print/non-TTY) first-run disclosure. */
export const FIRST_RUN_NOTICE_WIDTH = 64;

/** Greedy word-wrap to `width` columns. Input carries no existing newlines. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";

  for (const word of text.split(/\s+/)) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) {
    lines.push(line);
  }

  return lines;
}

/**
 * The plain-text first-run disclosure for print/non-TTY output: the same copy as
 * the interactive box (single-sourced in telemetry/config.ts), framed with light
 * rules and wrapped to a fixed width. Rendered gray when stderr is a TTY, plain
 * when redirected so a captured log stays free of escape codes.
 */
export function renderFirstRunNoticeText(color: boolean): string {
  const label = "OpenWiki telemetry";
  const width = FIRST_RUN_NOTICE_WIDTH;
  const topRule = `─── ${label} ${"─".repeat(Math.max(3, width - label.length - 5))}`;
  const block = [
    "",
    topRule,
    "",
    ...wrapText(FIRST_RUN_NOTICE_BODY, width),
    "",
    ...wrapText(FIRST_RUN_NOTICE_OPT_OUT, width),
    "",
    ...wrapText(FIRST_RUN_NOTICE_VERIFY, width),
    "─".repeat(width),
    "",
  ].join("\n");

  return color ? `\u001b[90m${block}\u001b[39m` : block;
}

/**
 * The one-time telemetry disclosure, rendered as a box so it sits inline with
 * the rest of the TUI (mirrors SetupHeader's rounded style). The copy is
 * single-sourced in telemetry/config.ts; the print/non-TTY path renders the
 * same wording as plain text via renderFirstRunNoticeText.
 */
export function FirstRunNotice() {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
    >
      <Text>
        <Text bold color="cyan">
          OpenWiki
        </Text>{" "}
        <Text color="gray">telemetry</Text>
      </Text>
      <Text color="white">{FIRST_RUN_NOTICE_BODY}</Text>
      <Text color="white">{FIRST_RUN_NOTICE_OPT_OUT}</Text>
      <Text color="white">{FIRST_RUN_NOTICE_VERIFY}</Text>
    </Box>
  );
}
