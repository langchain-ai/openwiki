import type { BackendProtocolV2, FileInfo } from "deepagents";
import path from "node:path";
import type { OpenWikiOutputMode } from "../agent/types.js";
import { extractMermaidFences } from "./fences.js";
import { degradeInvalidMermaidFences } from "./validate.js";

/**
 * Reserved or control files that never carry generated diagrams.
 */
const EXCLUDED_FILES = new Set([
  "index.md",
  "log.md",
  "_plan.md",
  "INSTRUCTIONS.md",
]);

/**
 * Summary of one mermaid validation pass over a generated wiki.
 */
export interface WikiMermaidReport {
  /**
   * How many Markdown files were scanned.
   */
  filesScanned: number;

  /**
   * How many mermaid fences were found across all scanned files.
   */
  fencesChecked: number;

  /**
   * How many fences were degraded to text fences.
   */
  fencesDegraded: number;

  /**
   * Wiki-root-relative paths of files that were rewritten.
   */
  repairedFiles: string[];
}

/**
 * Validates every mermaid fence in a generated wiki and degrades the invalid
 * ones in place.
 *
 * Walks the wiki through the backend virtual filesystem so writes stay inside
 * the docs-only boundary and both output modes work (`local-wiki` rooted at `/`,
 * `code` rooted at `/openwiki`). Files with no failing fences are left byte-for-
 * byte unchanged, so this creates no diff noise.
 */
export async function validateWikiMermaid(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
): Promise<WikiMermaidReport> {
  const root = outputMode === "local-wiki" ? "/" : "/openwiki";
  const report: WikiMermaidReport = {
    filesScanned: 0,
    fencesChecked: 0,
    fencesDegraded: 0,
    repairedFiles: [],
  };

  for (const filePath of await listMarkdownFiles(backend, root)) {
    report.filesScanned += 1;
    const original = await readText(backend, filePath);
    report.fencesChecked += extractMermaidFences(original).length;

    const { content, degraded } = await degradeInvalidMermaidFences(original);
    if (degraded === 0) {
      continue;
    }

    const result = await backend.edit(filePath, original, content);
    if (result.error) {
      throw new Error(`Unable to rewrite ${filePath}: ${result.error}`);
    }

    report.fencesDegraded += degraded;
    report.repairedFiles.push(path.posix.relative(root, filePath));
  }

  return report;
}

/**
 * Lists every non-reserved Markdown file under a wiki root, recursively.
 *
 * A missing root (for example, a run that produced no wiki) yields an empty
 * list rather than throwing, matching the index middleware's tolerance.
 */
async function listMarkdownFiles(
  backend: BackendProtocolV2,
  directoryPath: string,
): Promise<string[]> {
  const result = await backend.ls(directoryPath);
  if (result.error) {
    return [];
  }

  const files: string[] = [];
  for (const entry of result.files ?? []) {
    const name = entryName(entry);
    if (!name || name.startsWith(".")) {
      continue;
    }

    const entryPath = path.posix.join(directoryPath, name);
    if (entry.is_dir) {
      files.push(...(await listMarkdownFiles(backend, entryPath)));
    } else if (
      path.posix.extname(name).toLowerCase() === ".md" &&
      !EXCLUDED_FILES.has(name)
    ) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

/**
 * Reads a text file from the backend or throws an actionable error.
 */
async function readText(
  backend: BackendProtocolV2,
  filePath: string,
): Promise<string> {
  const result = await backend.readRaw(filePath);
  if (result.error) {
    throw new Error(`Unable to read ${filePath}: ${result.error}`);
  }

  const content = result.data?.content;
  if (Array.isArray(content)) {
    return content.join("\n");
  }
  if (typeof content === "string") {
    return content;
  }

  throw new Error(`${filePath} is not a text file`);
}

/**
 * Extracts an entry's basename from its virtual path.
 */
function entryName(entry: FileInfo): string {
  return path.posix.basename(entry.path.replace(/\/$/u, ""));
}
