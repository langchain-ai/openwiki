import { readFile } from "node:fs/promises";
import { HostIntegrationError } from "../core/errors.js";
import { writeTextAtomic } from "./atomic-file.js";
import type { HostIntegrationStatus } from "./types.js";

const START = "# OPENWIKI:MCP:START";
const END = "# OPENWIKI:MCP:END";

/**
 * Byte range occupied by one complete managed TOML block.
 */
interface MarkerRange {
  /**
   * Inclusive block start offset.
   */
  start: number;

  /**
   * Exclusive block end offset.
   */
  end: number;
}

/**
 * Installs an exact managed OpenWiki TOML block.
 *
 * @param filePath - Absolute Codex TOML config path.
 * @param host - Registry-owned host identifier.
 * @returns Whether the config changed.
 */
export async function installCodexMcpBlock(
  filePath: string,
  host: string,
): Promise<boolean> {
  const current = await readOptional(filePath);
  const block = renderBlock(host);
  const range = markerRange(current);
  if (range) {
    if (
      current.slice(range.start, range.end) !== block ||
      hasUnmanagedOpenWikiTable(current, range)
    ) {
      throw new HostIntegrationError(
        "conflict",
        `Refusing to replace a modified OpenWiki MCP block in ${filePath}.`,
      );
    }
    return false;
  }
  if (hasUnmanagedOpenWikiTable(current)) {
    throw new HostIntegrationError(
      "conflict",
      `An unmanaged openwiki MCP table already exists in ${filePath}.`,
    );
  }

  const separator =
    current.length === 0 || current.endsWith("\n\n") ? "" : "\n";
  await writeTextAtomic(filePath, `${current}${separator}${block}`);
  return true;
}

/**
 * Removes only the exact managed OpenWiki TOML block.
 *
 * @param filePath - Absolute Codex TOML config path.
 * @param host - Registry-owned host identifier.
 * @returns Whether the config changed.
 */
export async function uninstallCodexMcpBlock(
  filePath: string,
  host: string,
): Promise<boolean> {
  const current = await readOptional(filePath);
  const range = markerRange(current);
  if (!range) return false;
  if (
    current.slice(range.start, range.end) !== renderBlock(host) ||
    hasUnmanagedOpenWikiTable(current, range)
  ) {
    throw new HostIntegrationError(
      "conflict",
      `Refusing to remove a modified OpenWiki MCP block from ${filePath}.`,
    );
  }

  await writeTextAtomic(
    filePath,
    `${current.slice(0, range.start)}${current.slice(range.end)}`,
  );
  return true;
}

/**
 * Reports whether the exact managed Codex block is absent, intact, or modified.
 *
 * @param filePath - Absolute Codex TOML config path.
 * @param host - Registry-owned host identifier.
 * @returns Current managed-block state.
 */
export async function getCodexMcpBlockStatus(
  filePath: string,
  host: string,
): Promise<HostIntegrationStatus> {
  try {
    const current = await readOptional(filePath);
    const range = markerRange(current);
    if (!range) {
      return hasUnmanagedOpenWikiTable(current) ? "modified" : "not-installed";
    }
    return current.slice(range.start, range.end) === renderBlock(host) &&
      !hasUnmanagedOpenWikiTable(current, range)
      ? "installed"
      : "modified";
  } catch {
    return "modified";
  }
}

/**
 * Detects an OpenWiki MCP table outside the one managed marker range.
 *
 * @param content - Complete TOML config content.
 * @param managed - Expected managed block range, when present.
 * @returns Whether any matching table is outside the managed block.
 */
function hasUnmanagedOpenWikiTable(
  content: string,
  managed?: MarkerRange,
): boolean {
  for (const match of content.matchAll(
    /^\s*\[mcp_servers\.openwiki\]\s*$/gmu,
  )) {
    const index = match.index;
    if (!managed || index < managed.start || index >= managed.end) return true;
  }
  return false;
}

/**
 * Renders the canonical managed TOML block.
 *
 * @param host - Registry-owned host identifier.
 * @returns Complete marker-delimited TOML block.
 */
function renderBlock(host: string): string {
  return `${START}
[mcp_servers.openwiki]
command = "openwiki"
args = ["mcp", "--host", ${JSON.stringify(host)}]
${END}
`;
}

/**
 * Locates and validates the managed TOML marker pair.
 *
 * @param content - Complete TOML config content.
 * @returns Managed byte range, or `null` when both markers are absent.
 */
function markerRange(content: string): MarkerRange | null {
  const start = content.indexOf(START);
  const endMarker = content.indexOf(END);
  if (start === -1 && endMarker === -1) return null;
  if (start === -1 || endMarker === -1 || endMarker < start) {
    throw new HostIntegrationError(
      "invalid_input",
      "OpenWiki MCP markers are incomplete or out of order.",
    );
  }
  if (
    content.indexOf(START, start + START.length) !== -1 ||
    content.indexOf(END, endMarker + END.length) !== -1
  ) {
    throw new HostIntegrationError(
      "invalid_input",
      "OpenWiki MCP markers appear more than once.",
    );
  }

  let end = endMarker + END.length;
  if (content[end] === "\r") end += 1;
  if (content[end] === "\n") end += 1;
  return { start, end };
}

/**
 * Reads an optional UTF-8 config file.
 *
 * @param filePath - Absolute config path.
 * @returns File content, or an empty string when absent.
 */
async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
