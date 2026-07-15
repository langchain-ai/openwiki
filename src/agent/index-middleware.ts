import type { BackendProtocolV2, FileInfo } from "deepagents";
import { createMiddleware } from "langchain";
import path from "node:path";
import { parse } from "yaml";
import type { OpenWikiOutputMode } from "./types.js";

const INDEX_FILE = "index.md";
const EXCLUDED_FILES = new Set([INDEX_FILE, "_plan.md", "INSTRUCTIONS.md"]);

interface Directory {
  entries: FileInfo[];
  path: string;
}
interface Link {
  description?: string;
  href: string;
  label: string;
}

/** Creates middleware that synchronizes deterministic wiki indexes after a run. */
export function createOpenWikiIndexMiddleware(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
) {
  return createMiddleware({
    name: "OpenWikiIndexMiddleware",
    afterAgent: async () => {
      await synchronizeWikiIndexes(backend, outputMode);
    },
  });
}

/** Synchronizes the index for every directory in the configured wiki. */
export async function synchronizeWikiIndexes(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
): Promise<void> {
  const root = outputMode === "local-wiki" ? "/" : "/openwiki";
  for (const directory of await collectDirectories(backend, root, true)) {
    await synchronizeDirectory(backend, directory, root);
  }
}

/** Recursively collects visible wiki directories and their entries. */
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

/** Builds and writes one directory's index when its content has changed. */
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
    const metadata = parseFrontmatter(
      await readText(backend, filePath),
      filePath,
    );
    files.push({
      description: metadata.description,
      href: encodeURIComponent(name),
      label: metadata.title ?? path.posix.basename(name, ".md"),
    });
  }

  const indexPath = path.posix.join(directory.path, INDEX_FILE);
  const title =
    directory.path === root
      ? "OpenWiki"
      : titleFromSlug(path.posix.basename(directory.path));
  const content = renderIndex(title, files, directories);
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

/** Renders a complete deterministic index document. */
function renderIndex(
  title: string,
  files: Link[],
  directories: Link[],
): string {
  const sections = [
    renderLinks("Files", files, true),
    renderLinks("Directories", directories, false),
  ]
    .filter(Boolean)
    .join("\n\n");
  return `---\ntype: Documentation Index\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(`Files and subdirectories in ${title}.`)}\n---\n\n${sections}\n`;
}

/** Renders a sorted Markdown section for files or subdirectories. */
function renderLinks(
  heading: string,
  links: Link[],
  includeDescription: boolean,
): string {
  if (links.length === 0) return "";
  links.sort((left, right) => left.href.localeCompare(right.href));
  const items = links.map(({ description, href, label }) => {
    const link = `- [${escapeLabel(label)}](${href})`;
    return includeDescription ? `${link} - ${description}` : link;
  });
  return `# ${heading}\n\n${items.join("\n")}`;
}

/** Parses the title and required description from YAML front matter. */
function parseFrontmatter(
  content: string,
  filePath: string,
): { description: string; title?: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1];
  if (!block) throw new Error(`${filePath} lacks YAML front matter.`);

  let fields: unknown;
  try {
    fields = parse(block, {
      maxAliasCount: 100,
      schema: "core",
      uniqueKeys: true,
    }) as unknown;
  } catch (error) {
    throw new Error(
      `${filePath} contains invalid YAML front matter: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error(`${filePath} YAML front matter must be a mapping.`);
  }

  const { description, title } = fields as Record<string, unknown>;
  if (typeof description !== "string" || !description.trim()) {
    throw new Error(`${filePath} lacks a non-empty YAML description.`);
  }
  if (title !== undefined && typeof title !== "string") {
    throw new Error(`${filePath} YAML title must be a string.`);
  }
  return {
    description,
    ...(title ? { title } : {}),
  };
}

/** Converts an unknown thrown value into a readable message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads a text file from the backend or throws an actionable error. */
async function readText(
  backend: BackendProtocolV2,
  filePath: string,
): Promise<string> {
  const result = await backend.readRaw(filePath);
  if (result.error)
    throw new Error(`Unable to read ${filePath}: ${result.error}`);
  return fileDataToText(result.data?.content, filePath);
}

/** Converts supported backend file content into text. */
function fileDataToText(
  content: string | string[] | Uint8Array | undefined,
  filePath: string,
): string {
  if (Array.isArray(content)) return content.join("\n");
  if (typeof content === "string") return content;
  throw new Error(`${filePath} is not a text file.`);
}

/** Extracts an entry's basename from its virtual path. */
function entryName(entry: FileInfo): string {
  return path.posix.basename(entry.path.replace(/\/$/u, ""));
}

/** Converts a directory slug into a human-readable title. */
function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** Escapes a value for use as a Markdown link label. */
function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}
