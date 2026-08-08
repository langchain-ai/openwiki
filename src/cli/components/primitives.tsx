import React from "react";
import { Box, Text } from "ink";
import type { HelpRow } from "../commands.js";

/**
 * Props for a titled, indented content block.
 */
interface PanelProps {
  title: string;
  children: React.ReactNode;
}

/**
 * A titled section: a `#`-prefixed cyan header above left-indented children.
 */
export function Panel({ title, children }: PanelProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="cyan"># </Text>
        <Text bold>{title}</Text>
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * Props for a label/description table.
 */
interface RowsProps {
  rows: HelpRow[];
}

/**
 * Renders label/description pairs with the labels padded to a common width.
 */
export function Rows({ rows }: RowsProps) {
  const labelWidth = Math.max(...rows.map((row) => row.label.length));

  return (
    <>
      {rows.map((row) => (
        <Text key={row.label}>
          {"  "}
          {row.label.padEnd(labelWidth)}
          {"  "}
          {row.description}
        </Text>
      ))}
    </>
  );
}

/**
 * Props for a single tone-colored status line.
 */
interface StatusLineProps {
  tone: "active" | "error" | "muted" | "success";
  label: string;
  value: string;
}

/**
 * A single `* label value` line colored by tone (green/red/yellow/gray).
 */
export function StatusLine({ tone, label, value }: StatusLineProps) {
  const color =
    tone === "success"
      ? "green"
      : tone === "error"
        ? "red"
        : tone === "active"
          ? "yellow"
          : "gray";

  return (
    <Text>
      <Text color={color}>* </Text>
      <Text bold color={color}>
        {label}
      </Text>{" "}
      <Text color={tone === "muted" ? "gray" : undefined}>{value}</Text>
    </Text>
  );
}

/**
 * Props for a single selectable menu row.
 */
interface MenuRowProps {
  description: string;
  isSelected: boolean;
  label: string;
}

/**
 * A slash-menu row: a `>` marker plus padded label and gray description, bolded
 * and cyan when selected.
 */
export function MenuRow({ description, isSelected, label }: MenuRowProps) {
  return (
    <Text>
      <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? ">" : " "}</Text>{" "}
      <Text bold={isSelected}>{label.padEnd(28)}</Text>
      <Text color="gray">{description}</Text>
    </Text>
  );
}

/**
 * The blinking-style text-input caret glyph.
 */
export function InputCursor() {
  return <Text color="cyan">|</Text>;
}

/**
 * Props for an echoed user prompt block.
 */
interface PromptBlockProps {
  message: string;
}

/**
 * Echoes a submitted user message in a gray-backgrounded `>`-prefixed block.
 */
export function PromptBlock({ message }: PromptBlockProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text backgroundColor="gray" wrap="wrap">
        {" "}
        <Text color="cyan">{">"}</Text> {message}
      </Text>
    </Box>
  );
}
