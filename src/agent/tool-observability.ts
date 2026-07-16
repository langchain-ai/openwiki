import type { OpenWikiRunEvent } from "./types.js";

export type ToolUsageCounts = {
  agent: number;
  filesystem: number;
  openwiki: number;
};

const FILESYSTEM_TOOLS = new Set([
  "edit_file",
  "glob",
  "grep",
  "ls",
  "read_file",
  "write_file",
]);

export function incrementToolUsage(
  counts: ToolUsageCounts | undefined,
  toolName: string,
): ToolUsageCounts {
  const next = { ...(counts ?? { agent: 0, filesystem: 0, openwiki: 0 }) };

  if (FILESYSTEM_TOOLS.has(toolName)) {
    next.filesystem += 1;
  } else if (toolName.startsWith("openwiki_")) {
    next.openwiki += 1;
  } else {
    next.agent += 1;
  }

  return next;
}

export function formatToolUsageSummary(
  counts: ToolUsageCounts | undefined,
): string {
  if (!counts) return "";

  const parts = [
    counts.filesystem > 0
      ? `${counts.filesystem} filesystem ${counts.filesystem === 1 ? "operation" : "operations"}`
      : null,
    counts.openwiki > 0
      ? `${counts.openwiki} OpenWiki ${counts.openwiki === 1 ? "tool" : "tools"}`
      : null,
    counts.agent > 0
      ? `${counts.agent} agent ${counts.agent === 1 ? "tool" : "tools"}`
      : null,
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? ` | ${parts.join(" | ")}` : "";
}

export function incrementToolNameUsage(
  counts: Record<string, number> | undefined,
  toolName: string,
): Record<string, number> {
  return { ...counts, [toolName]: (counts?.[toolName] ?? 0) + 1 };
}

export function formatToolNameUsage(
  counts: Record<string, number> | undefined,
): string {
  if (!counts) return "";

  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}${count > 1 ? ` x${count}` : ""}`)
    .join(", ");
}

export function formatToolDebugEvent(event: OpenWikiRunEvent): string | null {
  if (event.type === "tool_start") {
    return `tool.start name=${event.name} id=${event.id}`;
  }
  if (event.type === "tool_end") {
    return `tool.end name=${event.name} id=${event.id} status=${event.status}`;
  }
  return null;
}
