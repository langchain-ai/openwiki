import type { BackendProtocolV2, FileInfo } from "deepagents";
import path from "node:path";
import type { OpenWikiOutputMode } from "../agent/types.js";
import {
  normalizeConceptContent,
  parseFrontmatterFields,
} from "./frontmatter.js";

const INDEX_FILE = "index.md";
const LOG_FILE = "log.md";
const EXCLUDED_FILES = new Set([
  INDEX_FILE,
  LOG_FILE,
  "_plan.md",
  "INSTRUCTIONS.md",
]);

/**
 * A wiki directory paired with the entries it directly contains.
 */
interface Directory {
  /**
   * All immediate entries (files and subdirectories) listed for the directory.
   */
  entries: FileInfo[];

  /**
   * Absolute virtual path of the directory within the wiki.
   */
  path: string;
}

/**
 * A rendered index entry pointing at a file or subdirectory.
 */
interface Link {
  /**
   * Optional one-line description rendered beside file links.
   */
  description?: string;

  /**
   * URL-encoded href relative to the containing index.
   */
  href: string;

  /**
   * Human-readable link label.
   */
  label: string;
}

/**
 * Synchronizes the index for every directory in the configured wiki.
 */
export async function synchronizeWikiIndexes(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
): Promise<void> {
  const root = outputMode === "local-wiki" ? "/" : "/openwiki";
  for (const directory of await collectDirectories(backend, root, true)) {
    await synchronizeDirectory(backend, directory, root);
  }
}

/**
 * Normalizes every concept page's OKF front matter across the wiki, without
 * touching indexes.
 *
 * Runs before the agent so an update operates over an already-conformant wiki:
 * legacy or externally edited pages are migrated to a minimal OKF block (tagged
 * `openwiki_generated`) up front, letting the agent read clean metadata and
 * enrich flagged pages in the same run.
 */
export async function migrateWikiToOkf(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
): Promise<void> {
  const root = outputMode === "local-wiki" ? "/" : "/openwiki";
  for (const directory of await collectDirectories(backend, root, true)) {
    for (const entry of directory.entries) {
      const name = entryName(entry);
      if (
        entry.is_dir ||
        !name ||
        name.startsWith(".") ||
        path.posix.extname(name).toLowerCase() !== ".md" ||
        EXCLUDED_FILES.has(name)
      ) {
        continue;
      }
      await normalizeConceptFile(
        backend,
        path.posix.join(directory.path, name),
      );
    }
  }
}

/**
 * Normalizes one concept file's OKF front matter in place.
 *
 * Reads the file, applies `normalizeConceptContent` and writes the result
 * back only when it changed. Returns the normalized content so a caller can read
 * its index metadata without a second read.
 */
async function normalizeConceptFile(
  backend: BackendProtocolV2,
  filePath: string,
): Promise<string> {
  const original = await readText(backend, filePath);
  const normalized = normalizeConceptContent(original, filePath);
  if (normalized.changed) {
    const result = await backend.edit(filePath, original, normalized.content);
    if (result.error) {
      throw new Error(`Unable to normalize ${filePath}: ${result.error}`);
    }
  }
  return normalized.content;
}

/**
 * Recursively collects visible wiki directories and their entries.
 */
async function collectDirectories(
  backend: BackendProtocolV2,
  directoryPath: string,
  allowMissing = false,
): Promise<Directory[]> {
  const result = await backend.ls(directoryPath);
  if (result.error) {
    if (allowMissing) return [];
    throw new Error(`Unable to list ${directoryPath}: ${result.error}`);
  }

  const entries = result.files ?? [];
  const children = entries.filter(
    (entry) => entry.is_dir && !entryName(entry).startsWith("."),
  );
  const descendants = await Promise.all(
    children.map((entry) =>
      collectDirectories(
        backend,
        path.posix.join(directoryPath, entryName(entry)),
      ),
    ),
  );
  return [...descendants.flat(), { entries, path: directoryPath }];
}

/**
 * Builds and writes one directory's index when its content has changed.
 */
async function synchronizeDirectory(
  backend: BackendProtocolV2,
  directory: Directory,
  root: string,
): Promise<void> {
  const files: Link[] = [];
  const directories: Link[] = [];

  for (const entry of directory.entries) {
    const name = entryName(entry);
    if (!name || name.startsWith(".")) continue;

    if (entry.is_dir) {
      directories.push({ href: `${encodeURIComponent(name)}/`, label: name });
      continue;
    }
    if (
      path.posix.extname(name).toLowerCase() !== ".md" ||
      EXCLUDED_FILES.has(name)
    ) {
      continue;
    }

    const filePath = path.posix.join(directory.path, name);
    const content = await normalizeConceptFile(backend, filePath);
    const metadata = readIndexMetadata(content);
    files.push({
      description: metadata.description,
      href: encodeURIComponent(name),
      label: metadata.title ?? path.posix.basename(name, ".md"),
    });
  }

  const indexPath = path.posix.join(directory.path, INDEX_FILE);
  const content = renderIndex(files, directories, directory.path === root);
  const existing = directory.entries.some(
    (entry) => !entry.is_dir && entryName(entry) === INDEX_FILE,
  )
    ? await readText(backend, indexPath)
    : null;
  if (existing === content) return;

  const result = existing
    ? await backend.edit(indexPath, existing, content)
    : await backend.write(indexPath, content);
  if (result.error) {
    throw new Error(`Unable to write ${indexPath}: ${result.error}`);
  }
}

/**
 * Renders a complete deterministic index document.
 */
function renderIndex(
  files: Link[],
  directories: Link[],
  isRoot: boolean,
): string {
  const sections = [
    renderLinks("Files", files, true),
    renderLinks("Directories", directories, false),
  ]
    .filter(Boolean)
    .join("\n\n");
  const version = isRoot ? '---\nokf_version: "0.1"\n---\n\n' : "";
  return `${version}${sections || "# Files"}\n`;
}

/**
 * Renders a sorted Markdown section for files or subdirectories.
 */
function renderLinks(
  heading: string,
  links: Link[],
  includeDescription: boolean,
): string {
  if (links.length === 0) return "";
  links.sort((left, right) => left.href.localeCompare(right.href));
  const items = links.map(({ description, href, label }) => {
    const link = `- [${escapeLabel(label)}](${href})`;
    return includeDescription && description
      ? `${link} - ${description}`
      : link;
  });
  return `# ${heading}\n\n${items.join("\n")}`;
}

/**
 * Reads usable optional display metadata; returns empty on any parse issue.
 */
function readIndexMetadata(content: string): {
  description?: string;
  title?: string;
} {
  const fields = parseFrontmatterFields(content);
  if (!fields) return {};
  const usableDescription = usableString(fields.description);
  const usableTitle = usableString(fields.title);
  return {
    ...(usableDescription ? { description: usableDescription } : {}),
    ...(usableTitle ? { title: usableTitle } : {}),
  };
}

/**
 * Returns optional front matter text only when it can be rendered in an index.
 */
function usableString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value;
}

/**
 * Reads a text file from the backend or throws an actionable error.
 */
async function readText(
  backend: BackendProtocolV2,
  filePath: string,
): Promise<string> {
  const result = await backend.readRaw(filePath);
  if (result.error)
    throw new Error(`Unable to read ${filePath}: ${result.error}`);
  return fileDataToText(result.data?.content, filePath);
}

/**
 * Converts supported backend file content into text.
 */
function fileDataToText(
  content: string | string[] | Uint8Array | undefined,
  filePath: string,
): string {
  if (Array.isArray(content)) return content.join("\n");
  if (typeof content === "string") return content;
  throw new Error(`${filePath} is not a text file.`);
}

/**
 * Extracts an entry's basename from its virtual path.
 */
function entryName(entry: FileInfo): string {
  return path.posix.basename(entry.path.replace(/\/$/u, ""));
}

/**
 * Escapes a value for use as a Markdown link label.
 */
function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}
