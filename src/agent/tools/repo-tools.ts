import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { resolveWithinRoot } from "./shared/path-validation.js";

export type RepositoryDiscoveryToolContext = {
  cwd: string;
};

const DEFAULT_EXCLUDE_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".cache",
  "coverage",
];
const MAX_ENTRIES = 5000;

/**
 * Builds the read-only repository file discovery tool. It walks the repository
 * tree with Node's `readdir` (never a shell), applying directory exclusions and
 * an optional extension filter, and caps the number of returned entries.
 */
export function createRepositoryDiscoveryTools(
  context: RepositoryDiscoveryToolContext,
): StructuredToolInterface[] {
  const { cwd } = context;

  return [
    new DynamicStructuredTool({
      name: "openwiki_list_repository_files",
      description:
        'List repository files recursively with sensible default exclusions (.git, node_modules, dist, build, .cache, coverage). Optional {"directory":"src","extensions":["ts","tsx"],"excludeDirs":["fixtures"]}. Returns repository-relative paths.',
      schema: {
        type: "object",
        properties: {
          directory: { type: "string" },
          extensions: {
            type: "array",
            items: { type: "string" },
          },
          excludeDirs: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      } as const,
      func: async (input) => {
        const directory = getOptionalStringInput(input, "directory") ?? "/";
        const extensions = normalizeExtensions(
          getStringArrayInput(input, "extensions"),
        );
        const excludeDirs = new Set([
          ...DEFAULT_EXCLUDE_DIRS,
          ...(getStringArrayInput(input, "excludeDirs") ?? []),
        ]);

        let startDir: string;
        try {
          startDir = resolveWithinRoot(directory, cwd);
        } catch (error) {
          return JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          });
        }

        const files: string[] = [];
        const truncated = await collectFiles(
          startDir,
          cwd,
          excludeDirs,
          extensions,
          files,
        );

        return JSON.stringify(
          {
            files,
            truncated,
            ...(truncated ? { entryCap: MAX_ENTRIES } : {}),
          },
          null,
          2,
        );
      },
    }),
  ];
}

async function collectFiles(
  currentDir: string,
  rootDir: string,
  excludeDirs: Set<string>,
  extensions: Set<string> | null,
  files: string[],
): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (files.length >= MAX_ENTRIES) {
      return true;
    }

    const entryPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name)) {
        continue;
      }

      const truncated = await collectFiles(
        entryPath,
        rootDir,
        excludeDirs,
        extensions,
        files,
      );
      if (truncated) {
        return true;
      }

      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (extensions !== null && !extensions.has(getExtension(entry.name))) {
      continue;
    }

    files.push(toPosixRelative(rootDir, entryPath));
  }

  return files.length >= MAX_ENTRIES;
}

function normalizeExtensions(extensions: string[] | undefined): Set<string> | null {
  if (extensions === undefined || extensions.length === 0) {
    return null;
  }

  return new Set(
    extensions.map((extension) =>
      extension.replace(/^\./u, "").toLowerCase(),
    ),
  );
}

function getExtension(fileName: string): string {
  return path.extname(fileName).replace(/^\./u, "").toLowerCase();
}

function toPosixRelative(rootDir: string, entryPath: string): string {
  return path
    .relative(path.resolve(rootDir), entryPath)
    .split(path.sep)
    .join("/");
}

function getOptionalStringInput(input: unknown, key: string): string | null {
  if (!isRecord(input) || input[key] === undefined || input[key] === null) {
    return null;
  }

  if (typeof input[key] !== "string") {
    throw new Error(`Expected string input: ${key}`);
  }

  return input[key];
}

function getStringArrayInput(
  input: unknown,
  key: string,
): string[] | undefined {
  if (!isRecord(input) || input[key] === undefined) {
    return undefined;
  }

  if (!Array.isArray(input[key])) {
    throw new Error(`Expected string array input: ${key}`);
  }

  return input[key].filter(
    (value): value is string => typeof value === "string",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
