import { compareStrings } from "../core/order.js";
import type { KnowledgeArtifact, KnowledgeDocument } from "../core/types.js";

/**
 * Default section size. This is deliberately a character limit rather than a
 * provider-specific token count so section boundaries are stable across models.
 */
export const DEFAULT_MAX_SECTION_CHARS = 6_000;

/**
 * One stable, addressable portion of a Markdown knowledge artifact.
 */
export interface ArtifactSection {
  /**
   * Stable identity derived from document path and ordinal.
   */
  id: string;

  /**
   * Path of the source document relative to the artifact root.
   */
  relativePath: string;

  /**
   * Active ATX heading hierarchy at the start of this section.
   */
  headingPath: string[];

  /**
   * Zero-based position within the source document.
   */
  ordinal: number;

  /**
   * Exact Markdown assigned to this section.
   */
  content: string;

  /**
   * Path, headings, and content indexed for lexical retrieval.
   */
  searchableText: string;
}

/**
 * Options for deterministic artifact sectioning.
 */
export interface SectionArtifactOptions {
  /**
   * Maximum characters in a section. Oversized content is split at paragraph
   * boundaries when possible and at the exact limit otherwise.
   *
   * @default 6000
   */
  maxSectionChars?: number;
}

/**
 * Internal Markdown chunk paired with its active heading hierarchy.
 */
interface HeadingChunk {
  /**
   * Active ATX heading hierarchy for the chunk.
   */
  headingPath: string[];

  /**
   * Exact Markdown content belonging to the chunk.
   */
  content: string;
}

/**
 * Determine whether a knowledge document is Markdown.
 *
 * @param document - Knowledge document to inspect.
 *
 * @returns Whether the document path has a Markdown extension.
 */
function isMarkdown(document: KnowledgeDocument): boolean {
  return /\.md$/i.test(document.relativePath);
}

/**
 * Parse an ATX heading outside a fence. CommonMark allows up to three leading
 * spaces and requires whitespace (or end of line) after the opening hashes.
 */
function parseAtxHeading(
  line: string,
): { depth: number; title: string } | undefined {
  const withoutNewline = line.replace(/\r?\n$/, "");
  const match = /^ {0,3}(#{1,6})(?:[\t ]+(.*)|[\t ]*)$/.exec(withoutNewline);

  if (match === null) {
    return undefined;
  }

  const rawTitle = match[2] ?? "";
  const title = rawTitle.replace(/[\t ]+#+[\t ]*$/, "").trim();

  return { depth: match[1].length, title };
}

/**
 * Parse a possible opening fenced-code marker.
 *
 * @param line - Markdown source line.
 *
 * @returns Fence metadata when the line opens a fence.
 */
function parseOpeningFence(
  line: string,
): { marker: "`" | "~"; length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);

  if (match === null) {
    return undefined;
  }

  return {
    marker: match[1][0] as "`" | "~",
    length: match[1].length,
  };
}

/**
 * Determine whether a line closes the active fenced-code block.
 *
 * @param line - Markdown source line.
 * @param fence - Active opening-fence metadata.
 *
 * @returns Whether the line is a valid closing fence.
 */
function isClosingFence(
  line: string,
  fence: { marker: "`" | "~"; length: number },
): boolean {
  const withoutNewline = line.replace(/\r?\n$/, "");
  const match = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(withoutNewline);

  return (
    match !== null &&
    match[1][0] === fence.marker &&
    match[1].length >= fence.length
  );
}

/**
 * Divide one document at headings while retaining every source character.
 * Heading lines belong to the section whose hierarchy they introduce.
 */
function splitAtHeadings(document: KnowledgeDocument): HeadingChunk[] {
  const lines = document.content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const chunks: HeadingChunk[] = [];
  const headings: string[] = [];
  let activeHeadingPath: string[] = [];
  let current = "";
  let fence: { marker: "`" | "~"; length: number } | undefined;

  /**
   * Persist the accumulated source as a chunk and reset the accumulator.
   */
  const flush = (): void => {
    if (current.length === 0) {
      return;
    }

    chunks.push({ headingPath: [...activeHeadingPath], content: current });
    current = "";
  };

  for (const line of lines) {
    if (fence === undefined) {
      const heading = parseAtxHeading(line);

      if (heading !== undefined) {
        flush();
        headings.length = heading.depth;
        headings[heading.depth - 1] = heading.title;
        // A skipped heading level has no title and should not introduce
        // undefined values into the public string[] contract.
        activeHeadingPath = headings.filter(
          (value): value is string => value !== undefined,
        );
      }

      const openingFence = parseOpeningFence(line);

      if (openingFence !== undefined) {
        fence = openingFence;
      }
    } else if (isClosingFence(line, fence)) {
      fence = undefined;
    }

    current += line;
  }

  flush();

  // Keep empty Markdown documents addressable. Their path remains searchable,
  // while precision extraction can correctly find no assertions in the content.
  if (chunks.length === 0) {
    chunks.push({ headingPath: [], content: "" });
  }

  return chunks;
}

/**
 * Split a heading chunk to the configured cap without dropping or reordering a
 * character. Prefer the last blank-line paragraph boundary at or before the cap.
 */
function splitOversized(content: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let remaining = content;

  while (remaining.length > maxChars) {
    const candidate = remaining.slice(0, maxChars);
    const lfIndex = candidate.lastIndexOf("\n\n");
    const crlfIndex = candidate.lastIndexOf("\r\n\r\n");
    const lfBoundary = lfIndex === -1 ? -1 : lfIndex + 2;
    const crlfBoundary = crlfIndex === -1 ? -1 : crlfIndex + 4;
    const paragraphBoundary = Math.max(lfBoundary, crlfBoundary);
    const splitAt = paragraphBoundary !== -1 ? paragraphBoundary : maxChars;

    pieces.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  pieces.push(remaining);
  return pieces;
}

/**
 * Convert an immutable artifact into stable Markdown sections. This function
 * uses only `artifact.documents`; it never reads the artifact snapshot directory.
 *
 * @param artifact - Captured knowledge artifact.
 * @param options - Optional deterministic section-size override.
 *
 * @returns Markdown sections ordered by path and then source position.
 */
export function sectionArtifact(
  artifact: KnowledgeArtifact,
  options: SectionArtifactOptions = {},
): ArtifactSection[] {
  const maxSectionChars = options.maxSectionChars ?? DEFAULT_MAX_SECTION_CHARS;

  if (!Number.isInteger(maxSectionChars) || maxSectionChars <= 0) {
    throw new RangeError("maxSectionChars must be a positive integer.");
  }

  const documents = [...artifact.documents]
    .filter(isMarkdown)
    .sort((a, b) => compareStrings(a.relativePath, b.relativePath));
  const sections: ArtifactSection[] = [];

  for (const document of documents) {
    let ordinal = 0;

    for (const chunk of splitAtHeadings(document)) {
      for (const content of splitOversized(chunk.content, maxSectionChars)) {
        const id = `${document.relativePath}::${String(ordinal).padStart(4, "0")}`;
        const headingPath = [...chunk.headingPath];

        sections.push({
          id,
          relativePath: document.relativePath,
          headingPath,
          ordinal,
          content,
          searchableText: [
            document.relativePath,
            headingPath.join(" > "),
            content,
          ]
            .filter((part) => part.length > 0)
            .join("\n"),
        });
        ordinal += 1;
      }
    }
  }

  return sections;
}
