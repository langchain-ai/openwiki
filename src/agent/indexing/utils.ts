import type { BackendProtocolV2 } from "deepagents";
import path from "node:path";
import type { OpenWikiOutputMode } from "../types.js";

export const INDEX_FILE_NAME = "index.md";
const EXCLUDED_FILES = new Set([
  ".last-update.json",
  "_plan.md",
  "INSTRUCTIONS.md",
  INDEX_FILE_NAME,
]);

export type IndexBackend = Pick<
  BackendProtocolV2,
  "edit" | "ls" | "readRaw" | "write"
>;

export type IndexMetadata = {
  description?: string;
  title?: string;
};

export type PendingIndex = {
  description?: string;
  exists: boolean;
  path: string;
};

export function getWikiRoot(outputMode: OpenWikiOutputMode): string {
  return outputMode === "local-wiki" ? "/" : "/openwiki";
}

export function getPendingIndexPaths(
  editedPaths: string[],
  outputMode: OpenWikiOutputMode,
): string[] {
  const root = getWikiRoot(outputMode);
  const pending = new Set<string>();

  for (const editedPath of editedPaths) {
    const normalized = normalizeVirtualPath(editedPath);

    if (
      !isWithinRoot(normalized, root) ||
      path.posix.extname(normalized).toLowerCase() !== ".md" ||
      EXCLUDED_FILES.has(path.posix.basename(normalized))
    ) {
      continue;
    }

    for (let directory = path.posix.dirname(normalized); ;) {
      pending.add(toIndexPath(directory));
      if (directory === root) break;
      directory = path.posix.dirname(directory);
    }
  }

  return [...pending].sort(
    (left, right) =>
      right.split("/").length - left.split("/").length ||
      left.localeCompare(right),
  );
}

export function validateIndexPath(
  indexPath: string,
  outputMode: OpenWikiOutputMode,
): string {
  const normalized = normalizeVirtualPath(indexPath);
  const root = getWikiRoot(outputMode);

  if (
    path.posix.basename(normalized) !== INDEX_FILE_NAME ||
    !isWithinRoot(normalized, root)
  ) {
    throw new Error(
      `Index path must point to ${INDEX_FILE_NAME} inside ${root}: ${indexPath}`,
    );
  }

  return normalized;
}

export function getParentIndexPath(
  indexPath: string,
  outputMode: OpenWikiOutputMode,
): string | null {
  const directory = path.posix.dirname(indexPath);
  const root = getWikiRoot(outputMode);
  return directory === root ? null : toIndexPath(path.posix.dirname(directory));
}

export async function readTextIfExists(
  backend: IndexBackend,
  filePath: string,
): Promise<string | null> {
  const listing = await backend.ls(path.posix.dirname(filePath));
  const name = path.posix.basename(filePath);

  if (
    listing.error ||
    !(listing.files ?? []).some(
      (entry) =>
        !entry.is_dir &&
        path.posix.basename(entry.path.replace(/\/$/u, "")) === name,
    )
  ) {
    return null;
  }

  const result = await backend.readRaw(filePath);
  const content = result.data?.content;

  if (result.error || content === undefined || content instanceof Uint8Array) {
    throw new Error(
      `Unable to read text file ${filePath}: ${result.error ?? "no text data"}`,
    );
  }

  return Array.isArray(content) ? content.join("\n") : content;
}

export function parseIndexMetadata(content: string): IndexMetadata {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1];
  if (!block) return {};

  const metadata: IndexMetadata = {};
  for (const line of block.split(/\r?\n/u)) {
    const field = /^(title|description):\s*(.*?)\s*$/u.exec(line);
    if (!field?.[2]) continue;
    metadata[field[1] as keyof IndexMetadata] = parseYamlString(field[2]);
  }
  return metadata;
}

export async function renderIndex(
  backend: IndexBackend,
  indexPath: string,
  metadata: Required<IndexMetadata>,
): Promise<string> {
  const directory = path.posix.dirname(indexPath);
  const listing = await backend.ls(directory);
  if (listing.error)
    throw new Error(`Unable to list ${directory}: ${listing.error}`);

  const files = [];
  const directories = [];

  for (const entry of listing.files ?? []) {
    const name = path.posix.basename(entry.path.replace(/\/$/u, ""));
    if (!name || name.startsWith(".")) continue;

    if (entry.is_dir) {
      const childPath = path.posix.join(directory, name, INDEX_FILE_NAME);
      const childContent = await readTextIfExists(backend, childPath);
      if (!childContent) {
        throw new Error(`Create ${childPath} before ${indexPath}.`);
      }
      const child = parseIndexMetadata(childContent);
      if (!child.description)
        throw new Error(`${childPath} lacks an OKF description.`);
      directories.push({
        description: child.description,
        link: `${encodeURIComponent(name)}/`,
        title: child.title ?? titleFromSlug(name),
      });
      continue;
    }

    if (
      path.posix.extname(name).toLowerCase() !== ".md" ||
      EXCLUDED_FILES.has(name)
    ) {
      continue;
    }

    const filePath = path.posix.join(directory, name);
    const file = parseIndexMetadata(
      (await readTextIfExists(backend, filePath)) ?? "",
    );
    if (!file.description)
      throw new Error(`${filePath} lacks an OKF description.`);
    files.push({
      description: file.description,
      link: encodeURIComponent(name),
      title: file.title ?? titleFromSlug(path.posix.basename(name, ".md")),
    });
  }

  const sections = [
    renderSection("Files", files),
    renderSection("Directories", directories),
  ]
    .filter(Boolean)
    .join("\n\n");

  return `---\ntype: Documentation Index\ntitle: ${JSON.stringify(metadata.title)}\ndescription: ${JSON.stringify(metadata.description)}\n---\n\n${sections}\n`;
}

export function deriveIndexTitle(
  indexPath: string,
  outputMode: OpenWikiOutputMode,
): string {
  const directory = path.posix.dirname(indexPath);
  return directory === getWikiRoot(outputMode)
    ? "OpenWiki"
    : titleFromSlug(path.posix.basename(directory));
}

function renderSection(
  heading: string,
  entries: Array<{ description: string; link: string; title: string }>,
): string {
  if (entries.length === 0) return "";
  entries.sort((left, right) => left.link.localeCompare(right.link));
  return `# ${heading}\n\n${entries
    .map(
      ({ description, link, title }) =>
        `- [${escapeLabel(title)}](${link}) - ${description}`,
    )
    .join("\n")}`;
}

function normalizeVirtualPath(filePath: string): string {
  const value = filePath.trim().replace(/\\/gu, "/");
  if (!value || value.startsWith("~") || value.split("/").includes("..")) {
    throw new Error(`Invalid virtual path: ${filePath}`);
  }
  return path.posix.normalize(value.startsWith("/") ? value : `/${value}`);
}

function isWithinRoot(filePath: string, root: string): boolean {
  return root === "/" || filePath === root || filePath.startsWith(`${root}/`);
}

function toIndexPath(directory: string): string {
  return directory === "/"
    ? `/${INDEX_FILE_NAME}`
    : path.posix.join(directory, INDEX_FILE_NAME);
}

function parseYamlString(value: string): string {
  if (value.startsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "string")
      throw new Error("OKF values must be strings.");
    return parsed;
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  return value.replace(/\s+#.*$/u, "").trim();
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
