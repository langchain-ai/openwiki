import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { OKF_INDEX_FILENAME, OKF_VERSION } from "./taxonomy.js";
import {
  ensureTrailingNewline,
  parseFrontmatter,
  stripLeadingBlankLines,
} from "./frontmatter.js";
import { readFileOrNull, writeIfDifferent } from "./bundle.js";

/**
 * A concept page's stamped metadata, used to render the root index.
 */
export interface ConceptSummary {
  /**
   * Bundle-relative path of the concept file.
   */
  relativePath: string;

  /**
   * Stamped OKF type, used to group the root index.
   */
  type: string;

  /**
   * Stamped title, used as the link text in the root index.
   */
  title: string;

  /**
   * Stamped description, or undefined when none could be derived.
   */
  description: string | undefined;
}

/**
 * Renders the root index.md: okf_version frontmatter + type-grouped links.
 */
export function renderRootIndex(concepts: ConceptSummary[]): string {
  const byType = new Map<string, ConceptSummary[]>();
  for (const concept of concepts) {
    const group = byType.get(concept.type) ?? [];
    group.push(concept);
    byType.set(concept.type, group);
  }

  const sections: string[] = [];
  for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
    const group = (byType.get(type) ?? []).sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    );
    const lines = group.map((concept) => {
      const link = `- [${concept.title}](/${concept.relativePath})`;
      return concept.description ? `${link} — ${concept.description}` : link;
    });
    sections.push(`## ${type}\n${lines.join("\n")}`);
  }

  const frontmatter = stringifyYaml({ okf_version: OKF_VERSION }).trimEnd();
  const body =
    sections.length > 0 ? sections.join("\n\n") : "No concepts documented yet.";

  return `---\n${frontmatter}\n---\n\n# Index\n\n${ensureTrailingNewline(body)}`;
}

/**
 * Strips frontmatter from every non-root index.md (spec forbids it there).
 */
export async function stripNonRootIndexFrontmatter(
  root: string,
  markdownFiles: string[],
): Promise<void> {
  for (const rel of markdownFiles) {
    if (
      path.basename(rel) !== OKF_INDEX_FILENAME ||
      rel === OKF_INDEX_FILENAME
    ) {
      continue;
    }
    const absolutePath = path.join(root, rel);
    const raw = await readFileOrNull(absolutePath);
    if (raw === null) {
      continue;
    }
    const { body } = parseFrontmatter(raw);
    await writeIfDifferent(
      absolutePath,
      raw,
      ensureTrailingNewline(stripLeadingBlankLines(body)),
    );
  }
}
