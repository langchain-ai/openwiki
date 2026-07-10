import path from "node:path";
import { getWikiContentRoot } from "../utils.js";
import { inferConceptType, OKF_INDEX_FILENAME } from "./taxonomy.js";
import {
  isNonEmptyString,
  parseFrontmatter,
  serializeFrontmatter,
  stripLeadingBlankLines,
  type Frontmatter,
} from "./frontmatter.js";
import {
  collectMarkdownFiles,
  isReservedFile,
  readFileOrNull,
  writeIfDifferent,
} from "./bundle.js";
import {
  renderRootIndex,
  stripNonRootIndexFrontmatter,
  type ConceptSummary,
} from "./reserved.js";
import type { OpenWikiCommand, OpenWikiOutputMode } from "../types.js";

/**
 * Inputs for a single {@link normalizeOkfBundle} run.
 */
export interface NormalizeOkfBundleOptions {
  /**
   * Runtime root (repo root for repository mode, wiki root for local-wiki).
   */
  cwd: string;

  /**
   * Output mode, which selects the content root and taxonomy.
   */
  outputMode: OpenWikiOutputMode;

  /**
   * The run command (init or update); drives log.md behavior.
   */
  command: OpenWikiCommand;

  /**
   * Model id recorded in the log.md entry.
   */
  model: string;

  /**
   * Injectable clock for deterministic tests; defaults to `new Date()`.
   */
  now?: Date;
}

/**
 * Normalizes the finished bundle into conformant OKF v0.1: stamps concept
 * frontmatter, strips reserved keys, and regenerates the root index.md. Safe to
 * run on every init/update.
 */
export async function normalizeOkfBundle(
  options: NormalizeOkfBundleOptions,
): Promise<void> {
  const { cwd, outputMode } = options;
  const root = getWikiContentRoot(cwd, outputMode);
  const timestamp = (options.now ?? new Date()).toISOString();

  const markdownFiles = await collectMarkdownFiles(root);
  const concepts: ConceptSummary[] = [];

  for (const relativePath of markdownFiles) {
    if (isReservedFile(relativePath)) {
      continue;
    }

    const absolutePath = path.join(root, relativePath);
    const raw = await readFileOrNull(absolutePath);
    if (raw === null) {
      continue;
    }

    const { data, body } = parseFrontmatter(raw);
    const normalized: Frontmatter = { ...data };

    delete normalized.okf_version; // reserved for the root index.md only

    if (!isNonEmptyString(normalized.type)) {
      normalized.type = inferConceptType(relativePath, outputMode);
    }
    if (!isNonEmptyString(normalized.title)) {
      normalized.title = deriveTitle(body, path.basename(relativePath));
    }
    if (!isNonEmptyString(normalized.description)) {
      const derived = deriveDescription(body);
      if (derived) {
        normalized.description = derived;
      }
    }
    normalized.timestamp = timestamp; // Phase 3 makes this body-hash aware

    await writeIfDifferent(
      absolutePath,
      raw,
      serializeFrontmatter(normalized, body),
    );

    concepts.push({
      relativePath,
      type: String(normalized.type),
      title: String(normalized.title),
      description: isNonEmptyString(normalized.description)
        ? normalized.description
        : undefined,
    });
  }

  await stripNonRootIndexFrontmatter(root, markdownFiles);

  const rootIndexPath = path.join(root, OKF_INDEX_FILENAME);
  const rootIndexBefore = await readFileOrNull(rootIndexPath);
  await writeIfDifferent(
    rootIndexPath,
    rootIndexBefore,
    renderRootIndex(concepts),
  );
}

/**
 * Derives a title from the first `#` heading, falling back to the filename.
 */
function deriveTitle(body: string, filename: string): string {
  const heading = /^#\s+(.+?)\s*$/mu.exec(body);
  if (heading?.[1]) {
    return heading[1].trim();
  }
  const base = filename.replace(/\.md$/u, "");
  const title = base
    .split(/[-_]/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return title.length > 0 ? title : base;
}

/**
 * Lifts the first sentence of the first non-heading paragraph as a description.
 */
function deriveDescription(body: string): string | undefined {
  for (const block of stripLeadingBlankLines(body).split(/\n\s*\n/u)) {
    const text = block.trim();
    if (text.length === 0 || text.startsWith("#") || text.startsWith("---")) {
      continue;
    }
    const sentence = /^(.*?[.!?])(\s|$)/su.exec(text)?.[1] ?? text;
    const oneLine = sentence.replace(/\s+/gu, " ").trim();
    return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
  }
  return undefined;
}
