import type { BackendProtocolV2, FileInfo } from "deepagents";
import { createMiddleware } from "langchain";
import path from "node:path";
import type { OpenWikiOutputMode } from "./types.js";

const INDEX_FILE = "index.md";
const EXCLUDED_FILES = new Set([INDEX_FILE, "_plan.md", "INSTRUCTIONS.md"]);

type IndexBackend = Pick<
  BackendProtocolV2,
  "edit" | "ls" | "readRaw" | "write"
>;

type Directory = { entries: FileInfo[]; path: string };
type Link = { description?: string; href: string; label: string };

export function createOpenWikiIndexMiddleware(
  backend: IndexBackend,
  outputMode: OpenWikiOutputMode,
) {
  return createMiddleware({
    name: "OpenWikiIndexMiddleware",
    afterAgent: async () => {
      await synchronizeWikiIndexes(backend, outputMode);
    },
  });
}

export async function synchronizeWikiIndexes(
  backend: IndexBackend,
  outputMode: OpenWikiOutputMode,
): Promise<void> {
  const root = outputMode === "local-wiki" ? "/" : "/openwiki";
  for (const directory of await collectDirectories(backend, root, true)) {
    await synchronizeDirectory(backend, directory, root);
  }
}

async function collectDirectories(
  backend: IndexBackend,
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

async function synchronizeDirectory(
  backend: IndexBackend,
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

function parseFrontmatter(
  content: string,
  filePath: string,
): { description: string; title?: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1];
  if (!block) throw new Error(`${filePath} lacks YAML front matter.`);

  const fields = new Map<string, string>();
  for (const line of block.split(/\r?\n/u)) {
    const field = /^(title|description):\s*(.+?)\s*$/u.exec(line);
    if (field) fields.set(field[1], parseScalar(field[2], filePath));
  }
  const description = fields.get("description");
  if (!description) {
    throw new Error(`${filePath} lacks a non-empty YAML description.`);
  }
  return {
    description,
    ...(fields.get("title") ? { title: fields.get("title") } : {}),
  };
}

function parseScalar(value: string, filePath: string): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string" && parsed) return parsed;
    } catch {
      // Fall through to the actionable error below.
    }
    throw new Error(`${filePath} contains an invalid quoted YAML string.`);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  return value.replace(/\s+#.*$/u, "").trim();
}

async function readText(
  backend: IndexBackend,
  filePath: string,
): Promise<string> {
  const result = await backend.readRaw(filePath);
  if (result.error)
    throw new Error(`Unable to read ${filePath}: ${result.error}`);
  return fileDataToText(result.data?.content, filePath);
}

function fileDataToText(
  content: string | string[] | Uint8Array | undefined,
  filePath: string,
): string {
  if (Array.isArray(content)) return content.join("\n");
  if (typeof content === "string") return content;
  throw new Error(`${filePath} is not a text file.`);
}

function entryName(entry: FileInfo): string {
  return path.posix.basename(entry.path.replace(/\/$/u, ""));
}

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}
