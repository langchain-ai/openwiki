import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  parseFrontmatterFields,
  splitFrontmatter,
} from "../okf/frontmatter.js";
import type {
  DocumentRole,
  IndexedChunk,
  OkfConcept,
  OkfRelationship,
  OpenWikiMetadata,
  RepositoryCorpus,
} from "./types.js";

const MAX_FILE_BYTES = 256_000;
const MAX_FILES = 5_000;
const SOURCE_LINES_PER_CHUNK = 80;
const SOURCE_LINE_OVERLAP = 16;
const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".svn",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);
const SECRET_FILE =
  /^(?:\.env(?:\..*)?|.*\.(?:crt|jks|key|keystore|p12|pem|pfx)|credentials\.json|token(?:\.json)?|cookies?(?:\.(?:db|sqlite|txt))?|\.git-credentials|hosts\.yml)$/iu;
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)]+)\)/gu;
const TEST_NAME =
  /\b(?:describe|it|test)(?:\.(?:each|only|skip|todo))?\s*\(\s*(["'`])([^\n]{1,160}?)\1/gu;
const DOCUMENT_ROLES = new Set<DocumentRole>([
  "architecture",
  "delivery",
  "domain",
  "integration",
  "operations",
  "reference",
  "repository",
  "testing",
  "workflow",
]);

export interface RepositoryIndexOptions {
  repoRoot: string;
  wikiRoot: string;
}

export async function buildRepositoryCorpus(
  options: RepositoryIndexOptions,
): Promise<RepositoryCorpus> {
  const repoRoot = await resolveDirectory(options.repoRoot, "repository root");
  const wikiRoot = await resolveDirectory(options.wikiRoot, "wiki root");
  const wikiPages = await readWikiPages(wikiRoot);
  const concepts = buildConcepts(wikiPages);
  connectIncomingRelationships(concepts);
  return {
    chunks: [
      ...wikiPages.flatMap((page) => page.chunks),
      ...(await readSourceChunks(repoRoot, wikiRoot)),
    ],
    concepts,
  };
}

interface WikiPage {
  chunks: IndexedChunk[];
  concept: OkfConcept;
}

async function readWikiPages(wikiRoot: string): Promise<WikiPage[]> {
  const files = await walkFiles(wikiRoot, (file) => file.endsWith(".md"));
  return Promise.all(
    files.map(async (file) => {
      const content = await readBoundedTextFile(wikiRoot, file);
      const relative = toPosix(path.relative(wikiRoot, file));
      const conceptPath = `openwiki/${relative}`;
      const fields = parseFrontmatterFields(content) ?? {};
      const { body } = splitFrontmatter(content);
      const title = stringField(fields.title) ?? firstHeading(body) ?? relative;
      const description = stringField(fields.description);
      const type = stringField(fields.type) ?? "Reference";
      const resource = stringField(fields.resource);
      const tags = stringArray(fields.tags);
      const metadata = parseOpenWikiMetadata(fields.openwiki);
      const roles = inferDocumentRoles(type, tags, relative, metadata.roles);
      return {
        chunks: chunkWikiPage({
          body,
          conceptPath,
          description,
          fields,
          relative,
          resource,
          roles,
          tags,
          title,
          type,
        }),
        concept: {
          ...(description ? { description } : {}),
          incoming: new Set<string>(),
          metadata: { ...metadata, roles },
          path: conceptPath,
          relationships: extractRelationships(body, relative),
          ...(resource ? { resource } : {}),
          roles,
          tags,
          title,
          type,
        },
      };
    }),
  );
}

async function readSourceChunks(
  repoRoot: string,
  wikiRoot: string,
): Promise<IndexedChunk[]> {
  const files = await walkFiles(repoRoot, (file) => {
    const extension = path.extname(file).toLowerCase();
    return SOURCE_EXTENSIONS.has(extension);
  });
  const chunks: IndexedChunk[] = [];
  for (const file of files) {
    if (isContained(wikiRoot, file)) continue;
    const content = await readBoundedTextFile(repoRoot, file);
    const relative = toPosix(path.relative(repoRoot, file));
    const lines = content.split(/\r?\n/u);
    for (
      let start = 0;
      start < lines.length;
      start += SOURCE_LINES_PER_CHUNK - SOURCE_LINE_OVERLAP
    ) {
      const selected = lines.slice(start, start + SOURCE_LINES_PER_CHUNK);
      if (selected.every((line) => !line.trim())) continue;
      const lineStart = start + 1;
      const lineEnd = start + selected.length;
      const text = selected.join("\n");
      const testNames = extractTestNames(text);
      chunks.push({
        fields: [relative, ...testNames].join("\n"),
        id: `source:${relative}:${lineStart}`,
        kind: "source",
        lineEnd,
        lineStart,
        path: relative,
        roles: [],
        scope: "source_code",
        tags: pathTags(relative),
        ...(testNames.length > 0 ? { testNames } : {}),
        text,
        title: path.basename(relative),
      });
    }
  }
  return chunks;
}

function chunkWikiPage(input: {
  body: string;
  conceptPath: string;
  description?: string;
  fields: Record<string, unknown>;
  relative: string;
  resource?: string;
  roles: DocumentRole[];
  tags: string[];
  title: string;
  type: string;
}): IndexedChunk[] {
  const lines = input.body.split(/\r?\n/u);
  const headingIndexes = lines
    .map((line, index) => (/^#{1,3}\s+\S/u.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (headingIndexes.length === 0) headingIndexes.push(0);
  return headingIndexes.map((start, index) => {
    const end = headingIndexes[index + 1] ?? lines.length;
    const selected = lines.slice(start, end);
    const heading = selected[0]?.replace(/^#{1,3}\s+/u, "").trim();
    return {
      conceptPath: input.conceptPath,
      ...(input.description ? { description: input.description } : {}),
      fields: JSON.stringify(input.fields),
      ...(heading ? { heading } : {}),
      id: `wiki:${input.relative}:${start + 1}`,
      kind: "wiki-section",
      lineEnd: Math.max(start + 1, end),
      lineStart: start + 1,
      path: input.conceptPath,
      ...(input.resource ? { resource: input.resource } : {}),
      roles: input.roles,
      scope: "wiki",
      tags: input.tags,
      text: [input.description, selected.join("\n")].filter(Boolean).join("\n"),
      title: input.title,
      type: input.type,
    };
  });
}

function buildConcepts(pages: WikiPage[]): Map<string, OkfConcept> {
  return new Map(pages.map((page) => [page.concept.path, page.concept]));
}

function connectIncomingRelationships(concepts: Map<string, OkfConcept>): void {
  for (const concept of concepts.values()) {
    concept.relationships = concept.relationships.filter((relationship) => {
      const target = concepts.get(relationship.target);
      if (!target) return false;
      target.incoming.add(concept.path);
      return true;
    });
  }
}

function extractRelationships(
  body: string,
  sourceRelative: string,
): OkfRelationship[] {
  const relationships: OkfRelationship[] = [];
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const rawTarget = (match[2] ?? "").trim().split("#", 1)[0] ?? "";
    if (!rawTarget || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(rawTarget)) continue;
    const sourceDirectory = path.posix.dirname(toPosix(sourceRelative));
    const resolved = path.posix.normalize(
      path.posix.join(sourceDirectory, rawTarget),
    );
    if (resolved.startsWith("../") || path.posix.isAbsolute(resolved)) continue;
    const target = `openwiki/${resolved.endsWith(".md") ? resolved : `${resolved}.md`}`;
    const offset = match.index ?? 0;
    relationships.push({
      context: relationshipContext(body, offset),
      kind: relationshipKind(relationshipContext(body, offset), sourceRelative),
      target,
    });
  }
  return relationships;
}

async function walkFiles(
  root: string,
  include: (file: string) => boolean,
): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < MAX_FILES) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (isSecretName(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (!isContained(root, candidate)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) pending.push(candidate);
      } else if (entry.isFile() && include(candidate)) {
        files.push(candidate);
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  return files;
}

async function readBoundedTextFile(
  root: string,
  file: string,
): Promise<string> {
  const resolved = await realpath(file);
  if (!isContained(root, resolved) || isSecretPath(resolved)) {
    throw new Error(
      "Refusing to read a path outside the indexed root or a secret-like file.",
    );
  }
  const info = await stat(resolved);
  if (info.size > MAX_FILE_BYTES) return "";
  const content = await readFile(resolved, "utf8");
  return content.includes("\0") ? "" : content;
}

async function resolveDirectory(value: string, label: string): Promise<string> {
  const resolved = await realpath(path.resolve(value));
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
  return resolved;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function isSecretPath(file: string): boolean {
  return file.split(path.sep).some(isSecretName);
}

function isSecretName(name: string): boolean {
  return (
    SECRET_FILE.test(name) ||
    /(?:credential|private[_-]?key|secret)/iu.test(name)
  );
}

function relationshipContext(body: string, offset: number): string {
  const start = Math.max(0, body.lastIndexOf("\n", offset - 160));
  const endCandidate = body.indexOf("\n", offset + 160);
  const end = endCandidate === -1 ? body.length : endCandidate;
  return body.slice(start, end).replace(/\s+/gu, " ").trim().slice(0, 320);
}

function pathTags(relative: string): string[] {
  return toPosix(relative)
    .split("/")
    .slice(0, -1)
    .filter((part) => part.length > 1);
}

function firstHeading(body: string): string | undefined {
  return /^#\s+(.+?)\s*$/mu.exec(body)?.[1]?.trim();
}

function extractTestNames(value: string): string[] {
  return [
    ...new Set(
      [...value.matchAll(TEST_NAME)]
        .map((match) => match[2]?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function parseOpenWikiMetadata(value: unknown): OpenWikiMetadata {
  const record = isRecord(value) ? value : {};
  return {
    changeKinds: slugArray(record.change_kinds, 16),
    invariants: boundedStringArray(record.invariants, 16, 400),
    roles: boundedStringArray(record.roles, 9, 40).filter(
      (role): role is DocumentRole => DOCUMENT_ROLES.has(role as DocumentRole),
    ),
    sourcePaths: pathArray(record.source_paths, 32),
    symbols: boundedStringArray(record.symbols, 48, 120).filter((symbol) =>
      /^[A-Za-z_$][A-Za-z0-9_$.:-]*$/u.test(symbol),
    ),
    testPaths: pathArray(record.test_paths, 32),
    validationCommands: boundedStringArray(record.validation_commands, 12, 300),
  };
}

function inferDocumentRoles(
  type: string,
  tags: string[],
  relative: string,
  declared: DocumentRole[],
): DocumentRole[] {
  const value = `${type} ${tags.join(" ")} ${relative}`.toLowerCase();
  const roles = new Set<DocumentRole>(declared);
  const add = (role: DocumentRole, pattern: RegExp): void => {
    if (pattern.test(value)) roles.add(role);
  };
  add(
    "architecture",
    /\b(?:architecture|engine|interface|memory|runtime|storage|system)\b/u,
  );
  add("delivery", /\b(?:artifact|build|delivery|package|publish|release)\b/u);
  add("domain", /\b(?:concept|data|domain|model|query|schema)\b/u);
  add(
    "integration",
    /\b(?:ecosystem|integration|platform|plugin|provider|react)\b/u,
  );
  add(
    "operations",
    /\b(?:contribution|development|operations|practice|tooling)\b/u,
  );
  add("repository", /\b(?:project|quickstart|repository)\b/u);
  add("testing", /\b(?:quality|test|testing|validation|verification)\b/u);
  add("workflow", /\b(?:automation|ingestion|lifecycle|playbook|workflow)\b/u);
  if (roles.size === 0) roles.add("reference");
  return [...roles];
}

function relationshipKind(
  context: string,
  sourceRelative: string,
): OkfRelationship["kind"] {
  if (/^(?:quickstart|index)\.md$/u.test(path.posix.basename(sourceRelative))) {
    return "navigation";
  }
  if (
    /\b(?:export|package|publish|release|ship|surface|bundle|deliver)\w*\b/iu.test(
      context,
    )
  ) {
    return "delivery";
  }
  if (
    /\b(?:lifecycle|transition|reset|reuse|before|after|enter|exit)\w*\b/iu.test(
      context,
    )
  ) {
    return "lifecycle";
  }
  if (
    /\b(?:call|depend|dispatch|own|share|configure|secure|adapt|consume)\w*\b/iu.test(
      context,
    )
  ) {
    return "dependency";
  }
  if (/\b(?:start|navigate|read|see|guide|overview)\w*\b/iu.test(context)) {
    return "navigation";
  }
  return "related";
}

function boundedStringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.replace(/\s+/gu, " ").trim())
        .filter((item) => item.length > 0 && item.length <= maximumLength),
    ),
  ].slice(0, maximumItems);
}

function slugArray(value: unknown, maximumItems: number): string[] {
  return boundedStringArray(value, maximumItems, 60)
    .map((item) => item.toLowerCase())
    .filter((item) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item));
}

function pathArray(value: unknown, maximumItems: number): string[] {
  return boundedStringArray(value, maximumItems, 300).filter(
    (item) =>
      !path.posix.isAbsolute(item) &&
      !item.includes("\\") &&
      !item.split("/").some((part) => part === "" || part === "..") &&
      !item.split("/").some(isSecretName),
  );
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
