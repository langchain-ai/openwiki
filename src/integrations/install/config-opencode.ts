import { readFile } from "node:fs/promises";
import { getNodeValue, parseTree, type Node } from "jsonc-parser";
import { HostIntegrationError } from "../core/errors.js";
import { writeTextAtomic } from "./atomic-file.js";
import type { HostIntegrationStatus, HostMcpServerCommand } from "./types.js";

const ENTRY_INDENT = "  ";
const SERVER_NAME = "openwiki";
const SERVER_TYPE = "local";
const COMMENT_PATTERN = /\/\/|\/\*/u;

/**
 * Exact property key of one property node.
 */
function propertyKey(node: Node): string | undefined {
  return node.type === "property"
    ? (node.children?.[0]?.value as string)
    : undefined;
}

/**
 * Value node for one property node.
 */
function propertyValue(node: Node): Node | undefined {
  return node.type === "property" ? node.children?.[1] : undefined;
}

/**
 * Finds one direct property of an object node by key.
 */
function findProperty(object: Node | undefined, key: string): Node | undefined {
  return object?.children?.find((child) => propertyKey(child) === key);
}

/**
 * Locates the root object, `mcp` value, and `openwiki` property nodes.
 */
function locateNodes(
  root: Node | undefined,
  filePath: string,
): {
  rootObject: Node;
  mcpObject: Node | undefined;
  openwikiProperty: Node | undefined;
} {
  if (!root || root.type !== "object") {
    throw new HostIntegrationError(
      "invalid_input",
      `Cannot update malformed OpenCode MCP config: ${filePath}.`,
    );
  }
  const mcpProperty = findProperty(root, "mcp");
  if (mcpProperty) {
    const mcpValue = propertyValue(mcpProperty);
    if (!mcpValue || mcpValue.type !== "object") {
      throw new HostIntegrationError(
        "invalid_input",
        `mcp must be an object in ${filePath}.`,
      );
    }
    return {
      rootObject: root,
      mcpObject: mcpValue,
      openwikiProperty: findProperty(mcpValue, SERVER_NAME),
    };
  }
  return {
    rootObject: root,
    mcpObject: undefined,
    openwikiProperty: undefined,
  };
}

/**
 * Parses the value of the managed entry into its exact parsed shape.
 */
function parsedEntry(node: Node | undefined): unknown {
  return node ? getNodeValue(node) : undefined;
}

/**
 * Compares an unknown JSON value with the exact managed entry shape.
 */
function matchesEntry(value: unknown, expected: HostMcpServerCommand): boolean {
  return deepEqual(value, entryFromCommand(expected));
}

/**
 * Renders the canonical OpenCode MCP entry object.
 */
function entryFromCommand(entry: HostMcpServerCommand): {
  type: string;
  command: string[];
  enabled: boolean;
} {
  return {
    type: SERVER_TYPE,
    command: [entry.command, ...entry.args],
    enabled: true,
  };
}

/**
 * Renders the entry as multi-line JSON text indented at the given level.
 */
function renderEntry(entry: HostMcpServerCommand, indent: number): string {
  const pad = ENTRY_INDENT.repeat(indent);
  const inner = ENTRY_INDENT.repeat(indent + 1);
  const command = `[${[entry.command, ...entry.args]
    .map((argument) => JSON.stringify(argument))
    .join(", ")}]`;
  return (
    `{\n` +
    `${inner}"type": ${JSON.stringify(SERVER_TYPE)},\n` +
    `${inner}"command": ${command},\n` +
    `${inner}"enabled": true\n` +
    `${pad}}`
  );
}

/**
 * Computes one object node's depth in the enclosing object hierarchy.
 *
 * @param node - Object node whose nesting depth should be measured.
 * @returns One for the root object, two for an object directly below it.
 */
function objectDepth(node: Node): number {
  let depth = 1;
  let current: Node | undefined = node.parent;
  while (current) {
    if (current.type === "object" || current.type === "array") depth += 1;
    current = current.parent;
  }
  return depth;
}

/**
 * Detects JSONC comments in one raw text slice.
 *
 * @param raw - Raw config text slice.
 * @returns Whether the slice contains a line or block comment.
 */
function hasComment(raw: string): boolean {
  return COMMENT_PATTERN.test(raw);
}

/**
 * Computes an insertion point and comma policy for one property.
 */
function insertionFor(object: Node): { index: number; prefix: string } {
  const last = object.children?.at(-1);
  if (!last) return { index: object.offset + 1, prefix: "" };
  return { index: last.offset + last.length, prefix: "," };
}

/**
 * Renders a complete fresh config owning only the managed entry.
 */
function renderFullConfig(entry: HostMcpServerCommand): string {
  return `{\n${ENTRY_INDENT}"mcp": {\n${ENTRY_INDENT}${ENTRY_INDENT}"${SERVER_NAME}": ${renderEntry(
    entry,
    2,
  )}\n${ENTRY_INDENT}}\n}\n`;
}

/**
 * Parses JSONC text into a strictly validated tree.
 */
function parseValidTree(text: string, filePath: string): Node | undefined {
  const errors: import("jsonc-parser").ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: true,
    allowEmptyContent: true,
  });
  if (errors.length > 0) {
    throw new HostIntegrationError(
      "invalid_input",
      `Cannot update malformed OpenCode MCP config: ${filePath}.`,
    );
  }
  return root;
}

/**
 * Installs the managed OpenWiki entry without discarding unrelated config.
 */
export async function installOpencodeMcpEntry(
  filePath: string,
  entry: HostMcpServerCommand,
  replaceableEntry?: HostMcpServerCommand,
): Promise<boolean> {
  const current = await readOptional(filePath);
  if (current.trim().length === 0) {
    await writeTextAtomic(filePath, renderFullConfig(entry));
    return true;
  }

  const root = parseValidTree(current, filePath);
  if (!root) {
    await writeTextAtomic(filePath, `${current}\n${renderFullConfig(entry)}`);
    return true;
  }
  const { rootObject, mcpObject, openwikiProperty } = locateNodes(
    root,
    filePath,
  );

  if (openwikiProperty) {
    const valueNode = propertyValue(openwikiProperty);
    const existing = parsedEntry(valueNode);
    if (matchesEntry(existing, entry)) return false;
    if (
      replaceableEntry &&
      matchesEntry(existing, replaceableEntry) &&
      valueNode
    ) {
      const raw = current.slice(
        valueNode.offset,
        valueNode.offset + valueNode.length,
      );
      if (hasComment(raw)) {
        throw new HostIntegrationError(
          "conflict",
          `Refusing to replace a modified openwiki MCP entry in ${filePath}.`,
        );
      }
      const replacement = renderEntry(entry, objectDepth(valueNode) - 1);
      await writeTextAtomic(
        filePath,
        `${current.slice(0, valueNode.offset)}${replacement}${current.slice(
          valueNode.offset + valueNode.length,
        )}`,
      );
      return true;
    }
    throw new HostIntegrationError(
      "conflict",
      `An openwiki MCP server already exists in ${filePath}.`,
    );
  }

  const targetObject = mcpObject ?? rootObject;
  const propertyLevel = objectDepth(targetObject);
  const propertyIndent = ENTRY_INDENT.repeat(propertyLevel);
  const propertyText =
    mcpObject === undefined
      ? `"mcp": {\n${ENTRY_INDENT.repeat(propertyLevel + 1)}"${SERVER_NAME}": ${renderEntry(entry, propertyLevel + 1)}\n${propertyIndent}}`
      : `"${SERVER_NAME}": ${renderEntry(entry, propertyLevel)}`;

  const { index, prefix } = insertionFor(targetObject);
  const { insertAt, removeEnd, insertText } = resolveInsert(
    current,
    targetObject,
    index,
    propertyText,
    prefix,
    propertyIndent,
  );
  await writeTextAtomic(
    filePath,
    `${current.slice(0, insertAt)}${insertText}${current.slice(removeEnd)}`,
  );
  return true;
}

/**
 * Removes only an exact managed OpenWiki entry.
 */
export async function uninstallOpencodeMcpEntry(
  filePath: string,
  expected: HostMcpServerCommand,
): Promise<boolean> {
  const current = await readOptional(filePath);
  if (current.trim().length === 0) return false;

  const root = parseValidTree(current, filePath);
  if (!root) return false;
  const { mcpObject, openwikiProperty } = locateNodes(root, filePath);
  if (!openwikiProperty) return false;

  const valueNode = propertyValue(openwikiProperty);
  if (!matchesEntry(parsedEntry(valueNode), expected)) {
    throw new HostIntegrationError(
      "conflict",
      `Refusing to remove a modified openwiki MCP entry from ${filePath}.`,
    );
  }
  if (
    valueNode &&
    hasComment(
      current.slice(valueNode.offset, valueNode.offset + valueNode.length),
    )
  ) {
    throw new HostIntegrationError(
      "conflict",
      `Refusing to remove a modified openwiki MCP entry from ${filePath}.`,
    );
  }

  const propertyStart = openwikiProperty.offset;
  const propertyEnd = openwikiProperty.offset + openwikiProperty.length;
  const siblings = mcpObject?.children ?? [];
  const previous = siblings[siblings.indexOf(openwikiProperty) - 1];
  const trailing = skipTriviaForward(current, propertyEnd);
  let start = propertyStart;
  let end = propertyEnd;
  if (previous) {
    const leading = skipTriviaForward(
      current,
      previous.offset + previous.length,
    );
    if (current[leading] === ",") start = leading;
    if (current[trailing] === ",") end = trailing;
  } else {
    if (current[trailing] === ",") end = trailing + 1;
    while (start > 0 && /\s/u.test(current[start - 1] ?? "")) start -= 1;
    if (end === propertyEnd) {
      while (end < current.length && /\s/u.test(current[end] ?? "")) end += 1;
    }
  }
  await writeTextAtomic(
    filePath,
    `${current.slice(0, start)}${current.slice(end)}`,
  );
  return true;
}

/**
 * Reports whether the exact managed entry is absent, intact, or modified.
 */
export async function getOpencodeMcpEntryStatus(
  filePath: string,
  expected: HostMcpServerCommand,
): Promise<HostIntegrationStatus> {
  try {
    const current = await readOptional(filePath);
    if (current.trim().length === 0) return "not-installed";
    const root = parseValidTree(current, filePath);
    if (!root) return "not-installed";
    const { openwikiProperty } = locateNodes(root, filePath);
    if (!openwikiProperty) return "not-installed";
    const valueNode = propertyValue(openwikiProperty);
    if (!valueNode) return "modified";
    const raw = current.slice(
      valueNode.offset,
      valueNode.offset + valueNode.length,
    );
    return matchesEntry(parsedEntry(valueNode), expected) && !hasComment(raw)
      ? "installed"
      : "modified";
  } catch {
    return "modified";
  }
}

/**
 * Reads an optional UTF-8 config file.
 */
async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/**
 * Resolves the insertion offset and text for one new object property.
 *
 * @param current - Complete raw config text.
 * @param object - Destination object node.
 * @param index - Preferred insertion offset after the last child or open brace.
 * @param propertyText - Rendered property text to insert.
 * @param prefix - Comma policy: `","` when children exist, `""` when empty.
 * @param propertyIndent - Indentation used for the new property line.
 * @returns Exact splice offset and complete inserted text.
 */
function resolveInsert(
  current: string,
  object: Node,
  index: number,
  propertyText: string,
  prefix: string,
  propertyIndent: string,
): { insertAt: number; removeEnd: number; insertText: string } {
  const close = object.offset + object.length - 1;
  if (prefix === "") {
    const interior = current.slice(index, close);
    if (/^\s*$/u.test(interior)) {
      return {
        insertAt: index,
        removeEnd: close,
        insertText: `\n${propertyIndent}${propertyText}\n`,
      };
    }
    const insertText = interior.includes("\n")
      ? `\n${propertyIndent}${propertyText}`
      : `\n${propertyIndent}${propertyText}\n`;
    return { insertAt: index, removeEnd: index, insertText };
  }
  let cursor = index;
  while (cursor < close && /\s/u.test(current[cursor] ?? "")) cursor += 1;
  if (current[cursor] === ",") {
    return {
      insertAt: cursor + 1,
      removeEnd: cursor + 1,
      insertText: `\n${propertyIndent}${propertyText}`,
    };
  }
  return {
    insertAt: index,
    removeEnd: index,
    insertText: `,\n${propertyIndent}${propertyText}`,
  };
}

/**
 * Skips whitespace and JSONC comments forward from one offset.
 *
 * @param current - Complete raw config text.
 * @param cursor - Offset to advance from.
 * @returns Offset of the first non-trivia character, or the text length.
 */
function skipTriviaForward(current: string, cursor: number): number {
  let index = cursor;
  while (index < current.length) {
    const char = current[index];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && current[index + 1] === "/") {
      const lineEnd = current.indexOf("\n", index + 2);
      if (lineEnd === -1) return current.length;
      index = lineEnd + 1;
      continue;
    }
    if (char === "/" && current[index + 1] === "*") {
      const close = current.indexOf("*/", index + 2);
      if (close === -1) return current.length;
      index = close + 2;
      continue;
    }
    break;
  }
  return index;
}

/**
 * Recursively compares two JSON values for exact structural equality.
 */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => deepEqual(left[key], right[key]))
    );
  }
  return false;
}

/**
 * Narrows an unknown value to a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
