import type { OpenWikiRunEvent } from "../../agent/types.js";
import { isRecord } from "../guards.js";

/**
 * The running/done phrasing for a tool action and whether its raw call detail
 * should be surfaced.
 */
export interface ToolDisplay {
  /**
   * The phrase shown once the action has completed.
   */
  done: string;

  /**
   * The phrase shown while the action is in progress.
   */
  running: string;

  /**
   * Whether to also show the tool's raw call string.
   */
  showDetail: boolean;
}

/**
 * Builds the human-friendly running/done phrasing for a starting tool call,
 * choosing a deterministic phrasing variant per call and counting the affected
 * targets so the copy can be singular or plural.
 */
export function createToolDisplay(
  event: Extract<OpenWikiRunEvent, { type: "tool_start" }>,
): ToolDisplay {
  const input = parseToolInput(event.input);
  const variantIndex = pickVariantIndex(
    `${event.id}:${event.name}:${event.call}`,
  );

  switch (event.name) {
    case "read_file": {
      const count = countToolTargets(input, ["path", "paths", "file", "files"]);
      return pickToolDisplay(
        variantIndex,
        [
          `Reading ${formatCount(count, "file", "files")}`,
          `Examining ${formatCount(count, "file", "files")}`,
          `Taking a look at ${formatCount(count, "file", "files")}`,
        ],
        [
          `Read ${formatCount(count, "file", "files")}`,
          `Examined ${formatCount(count, "file", "files")}`,
          `Looked at ${formatCount(count, "file", "files")}`,
        ],
      );
    }
    case "edit_file": {
      const count = countToolTargets(input, ["path", "paths", "file", "files"]);
      return pickToolDisplay(
        variantIndex,
        [
          `Editing ${formatCount(count, "file", "files")}`,
          `Updating ${formatCount(count, "file", "files")}`,
          `Applying changes to ${formatCount(count, "file", "files")}`,
        ],
        [
          `Edited ${formatCount(count, "file", "files")}`,
          `Updated ${formatCount(count, "file", "files")}`,
          `Applied changes to ${formatCount(count, "file", "files")}`,
        ],
        false,
      );
    }
    case "write_file": {
      const count = countToolTargets(input, ["path", "paths", "file", "files"]);
      return pickToolDisplay(
        variantIndex,
        [
          `Writing ${formatCount(count, "file", "files")}`,
          `Creating ${formatCount(count, "file", "files")}`,
          `Saving ${formatCount(count, "file", "files")}`,
        ],
        [
          `Wrote ${formatCount(count, "file", "files")}`,
          `Created ${formatCount(count, "file", "files")}`,
          `Saved ${formatCount(count, "file", "files")}`,
        ],
        false,
      );
    }
    case "ls":
      return pickToolDisplay(
        variantIndex,
        ["Listing files", "Scanning a directory", "Checking the file tree"],
        ["Listed files", "Scanned a directory", "Checked the file tree"],
      );
    case "glob":
      return pickToolDisplay(
        variantIndex,
        [
          "Finding matching files",
          "Searching file paths",
          "Scanning for matches",
        ],
        ["Found matching files", "Searched file paths", "Scanned for matches"],
      );
    case "grep":
      return pickToolDisplay(
        variantIndex,
        [
          "Searching file contents",
          "Grepping the codebase",
          "Looking for matches",
        ],
        [
          "Searched file contents",
          "Grepped the codebase",
          "Looked for matches",
        ],
      );
    case "write_todos": {
      const count = countTodoItems(input);
      return pickToolDisplay(
        variantIndex,
        [
          `Updating ${formatCount(count, "todo", "todos")}`,
          `Organizing ${formatCount(count, "todo", "todos")}`,
          `Refreshing ${formatCount(count, "todo", "todos")}`,
        ],
        [
          `Updated ${formatCount(count, "todo", "todos")}`,
          `Organized ${formatCount(count, "todo", "todos")}`,
          `Refreshed ${formatCount(count, "todo", "todos")}`,
        ],
      );
    }
    case "task": {
      const count = countToolTargets(input, [
        "tasks",
        "subagents",
        "agents",
        "items",
      ]);
      return pickToolDisplay(
        variantIndex,
        [
          `Starting ${formatCount(count, "task", "tasks")}`,
          `Opening ${formatCount(count, "task", "tasks")}`,
          `Working on ${formatCount(count, "task", "tasks")}`,
        ],
        [
          `Finished ${formatCount(count, "task", "tasks")}`,
          `Completed ${formatCount(count, "task", "tasks")}`,
          `Wrapped up ${formatCount(count, "task", "tasks")}`,
        ],
      );
    }
    default:
      return {
        done: event.call,
        running: event.call,
        showDetail: false,
      };
  }
}

/**
 * Selects one running/done phrasing pair by variant index, wrapping within the
 * available variants.
 *
 * @param showDetail Whether the chosen display should surface the raw call
 * string.
 *
 * @default showDetail true - the raw call string is surfaced unless a caller
 * opts out.
 */
export function pickToolDisplay(
  variantIndex: number,
  running: string[],
  done: string[],
  showDetail = true,
): ToolDisplay {
  const index = variantIndex % Math.min(running.length, done.length);

  return {
    done: done[index],
    running: running[index],
    showDetail,
  };
}

/**
 * Parses a tool input that may arrive as a JSON string, returning the value
 * unchanged when it is not a string or does not parse.
 */
export function parseToolInput(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }

  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

/**
 * Counts how many targets a tool acts on, reading the first of `keys` that
 * holds an array or non-empty string, and defaulting to one.
 */
export function countToolTargets(input: unknown, keys: string[]): number {
  if (Array.isArray(input)) {
    return Math.max(input.length, 1);
  }

  if (!isRecord(input)) {
    return 1;
  }

  for (const key of keys) {
    const value = input[key];

    if (Array.isArray(value)) {
      return Math.max(value.length, 1);
    }

    if (typeof value === "string" && value.trim().length > 0) {
      return 1;
    }
  }

  return 1;
}

/**
 * Counts the todo entries in a `write_todos` input, defaulting to one.
 */
export function countTodoItems(input: unknown): number {
  if (!isRecord(input)) {
    return 1;
  }

  const todos = input.todos ?? input.items;

  return Array.isArray(todos) ? Math.max(todos.length, 1) : 1;
}

/**
 * Formats a count with the singular or plural noun (e.g. `1 file`, `3 files`).
 */
export function formatCount(
  count: number,
  singular: string,
  plural: string,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Hashes a seed string into a non-negative integer used to pick a phrasing
 * variant deterministically per tool call.
 */
export function pickVariantIndex(seed: string): number {
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  return hash;
}
