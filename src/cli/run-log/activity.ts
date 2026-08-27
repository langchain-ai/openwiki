import path from "node:path";
import type { OpenWikiRunEvent } from "../../agent/types.js";
import { isRecord } from "../guards.js";
import { parseToolInput } from "./tool-input.js";
import type {
  RunActivityOperation,
  RunActivityScope,
  RunActivityStatus,
} from "./types.js";

/**
 * A path operation derived from an explicit filesystem tool call.
 */
export interface ToolPathActivity {
  /**
   * Filesystem operation represented by the tool call.
   */
  operation: RunActivityOperation;

  /**
   * Normalized repository-relative path or search scope.
   */
  path: string;

  /**
   * Side of the run that owns the path.
   */
  scope: RunActivityScope;
}

/**
 * A printable line in the compact activity tree.
 */
export interface ActivityTreeLine {
  /**
   * Fully formatted tree branch and path-segment label.
   */
  label: string;

  /**
   * Lifecycle status attached to a leaf path, when present.
   *
   * @default undefined - this line is an intermediate directory node.
   */
  status?: RunActivityStatus;
}

/**
 * A printable line in the cumulative repository exploration map.
 */
export interface ExplorationTreeLine {
  /**
   * Fully formatted tree branch, directory count, or active filename.
   */
  label: string;

  /**
   * Whether this line belongs to the file currently being read.
   */
  active: boolean;
}

/**
 * Internal trie node used to merge shared path ancestry.
 */
interface ActivityTreeNode {
  /**
   * Child nodes keyed by one normalized path segment.
   */
  children: Map<string, ActivityTreeNode>;

  /**
   * Lifecycle status attached to a terminal path node.
   *
   * @default undefined - this node is only shared ancestry.
   */
  status?: RunActivityStatus;
}

/**
 * One normalized path used as input to the printable activity tree.
 */
interface ActivityTreeInput {
  /**
   * Repository-relative path to add to the tree.
   */
  path: string;

  /**
   * Lifecycle status to attach to the terminal path node.
   *
   * @default undefined - the terminal node has no explicit status.
   */
  status?: RunActivityStatus;
}

const PATH_KEYS = [
  "path",
  "paths",
  "file",
  "files",
  "file_path",
  "file_paths",
] as const;

/**
 * Extracts exact paths or search scopes from a filesystem tool start. Shell
 * commands are deliberately excluded because their text is not reliable path
 * provenance.
 */
export function getToolPathActivities(
  event: Extract<OpenWikiRunEvent, { type: "tool_start" }>,
): ToolPathActivity[] {
  const input = parseToolInput(event.input);
  let operation: RunActivityOperation;
  let rawPaths: string[];

  switch (event.name) {
    case "read_file":
      operation = "read";
      rawPaths = getInputPaths(input, PATH_KEYS);
      break;
    case "edit_file":
    case "write_file":
      operation = "write";
      rawPaths = getInputPaths(input, PATH_KEYS);
      break;
    case "glob":
      operation = "search";
      rawPaths = getSearchScopes(input, ["path", "directory", "pattern"]);
      break;
    case "grep":
      operation = "search";
      rawPaths = getSearchScopes(input, ["path", "directory", "glob"]);
      break;
    case "ls":
      operation = "search";
      rawPaths = getInputPaths(input, ["path", "directory"]);
      break;
    default:
      return [];
  }

  return [...new Set(rawPaths)]
    .map(normalizeActivityPath)
    .filter((activityPath): activityPath is string => activityPath !== null)
    .map((activityPath) => ({
      operation,
      path: activityPath,
      scope: getActivityScope(activityPath),
    }));
}

/**
 * Builds the visible ancestry for a set of active paths, producing a familiar
 * repository-tree shape without rendering the repository's inactive files.
 */
export function buildActivityTreeLines(
  activities: ReadonlyArray<ActivityTreeInput>,
): ActivityTreeLine[] {
  const root: ActivityTreeNode = { children: new Map() };

  for (const activity of activities) {
    const parts = activity.path === "." ? ["."] : activity.path.split("/");
    let node = root;

    for (const part of parts) {
      const existing = node.children.get(part);
      const child: ActivityTreeNode = existing ?? { children: new Map() };
      node.children.set(part, child);
      node = child;
    }

    node.status = activity.status;
  }

  const lines: ActivityTreeLine[] = [];
  appendTreeLines(root, "", lines);
  return lines;
}

/**
 * Builds a cumulative directory map containing every successfully read
 * repository file. The current read is included and highlighted while active.
 */
export function buildExplorationTreeLines(
  exploredPaths: readonly string[],
  activePath: string | undefined,
): ExplorationTreeLine[] {
  const activities: ActivityTreeInput[] = [...new Set(exploredPaths)].map(
    (exploredPath) => ({ path: exploredPath, status: "recent" }),
  );
  if (activePath) {
    activities.push({ path: activePath, status: "active" });
  }

  return buildActivityTreeLines(activities).map((line) => ({
    active: line.status === "active",
    label: line.label,
  }));
}

/**
 * Returns whether a normalized activity path is a persistent OpenWiki page.
 * Non-Markdown sidecars are deliberately excluded from completion page counts.
 */
export function isOpenWikiPagePath(activityPath: string): boolean {
  return activityPath.startsWith("openwiki/") && activityPath.endsWith(".md");
}

function appendTreeLines(
  node: ActivityTreeNode,
  prefix: string,
  lines: ActivityTreeLine[],
): void {
  const children = [...node.children.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );

  children.forEach(([name, child], index) => {
    const isLast = index === children.length - 1;
    const hasChildren = child.children.size > 0;

    lines.push({
      label: `${prefix}${isLast ? "└─" : "├─"} ${name}${hasChildren ? "/" : ""}`,
      status: child.status,
    });

    appendTreeLines(child, `${prefix}${isLast ? "   " : "│  "}`, lines);
  });
}

function getInputPaths(input: unknown, keys: readonly string[]): string[] {
  if (typeof input === "string") {
    return [input];
  }

  if (Array.isArray(input)) {
    return input.filter((value): value is string => typeof value === "string");
  }

  if (!isRecord(input)) {
    return [];
  }

  for (const key of keys) {
    const value = input[key];

    if (typeof value === "string") {
      return [value];
    }

    if (Array.isArray(value)) {
      return value.filter(
        (candidate): candidate is string => typeof candidate === "string",
      );
    }
  }

  return [];
}

function getSearchScopes(input: unknown, keys: readonly string[]): string[] {
  return getInputPaths(input, keys).map(getSearchScope);
}

function getSearchScope(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const wildcardIndex = normalized.search(/[*?[\]{}]/u);

  if (wildcardIndex === -1) {
    return normalized;
  }

  const prefix = normalized.slice(0, wildcardIndex);

  if (prefix.endsWith("/")) {
    return prefix.replace(/\/$/u, "") || ".";
  }

  return prefix.length > 0 ? path.posix.dirname(prefix) : ".";
}

function normalizeActivityPath(value: string): string | null {
  const trimmed = value.trim().replaceAll("\\", "/");

  if (trimmed.length === 0 || trimmed.includes("://")) {
    return null;
  }

  const normalized = path.posix
    .normalize(trimmed.replace(/^\/+|^\.\//u, ""))
    .replace(/^\.\//u, "");

  if (normalized === ".." || normalized.startsWith("../")) {
    return null;
  }

  return normalized.length > 0 ? normalized : ".";
}

function getActivityScope(activityPath: string): RunActivityScope {
  return activityPath === "openwiki" ||
    activityPath.startsWith("openwiki/") ||
    activityPath === ".claims" ||
    activityPath.startsWith(".claims/")
    ? "openwiki"
    : "repository";
}
