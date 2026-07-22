/**
 * A single fenced ```mermaid block located inside a Markdown document.
 */
export interface MermaidFence {
  /**
   * Zero-based line index of the opening ```mermaid line.
   */
  openLine: number;

  /**
   * Zero-based line index of the closing ``` line.
   */
  closeLine: number;

  /**
   * Leading whitespace of the opening fence line, preserved on rewrite.
   */
  indent: string;

  /**
   * The backtick run that opened the fence (``` or longer).
   */
  marker: string;

  /**
   * Diagram text between the fence lines, excluding the fence lines themselves.
   */
  body: string;
}

/**
 * A ```mermaid fence whose opening has been seen but whose end is not yet known.
 */
interface OpenFence {
  /**
   * The fence fields known at open time; `closeLine` and `body` are filled in on close.
   */
  fence: Omit<MermaidFence, "closeLine" | "body">;

  /**
   * Lines collected between the opening fence and the current scan position, in order.
   */
  bodyLines: string[];
}

/**
 * Extracts every ```mermaid fence from a Markdown document.
 *
 * Generic fenced blocks are tracked so a ```mermaid example nested inside a
 * longer ````markdown fence is ignored, and indentation is preserved so fences
 * inside list items round-trip correctly on rewrite.
 */
export function extractMermaidFences(markdown: string): MermaidFence[] {
  const lines = markdown.split("\n");
  const fences: MermaidFence[] = [];

  let open: OpenFence | undefined;
  let genericFenceMarker: string | undefined;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const match = /^(\s*)(`{3,})\s*(\S*)\s*$/u.exec(line);

    if (open) {
      if (match && match[2].length >= open.fence.marker.length && !match[3]) {
        fences.push({
          ...open.fence,
          closeLine: idx,
          body: open.bodyLines.join("\n"),
        });
        open = undefined;
      } else {
        open.bodyLines.push(line);
      }
      continue;
    }

    if (genericFenceMarker) {
      if (match && match[2].length >= genericFenceMarker.length && !match[3]) {
        genericFenceMarker = undefined;
      }
      continue;
    }

    if (match && match[3].toLowerCase() === "mermaid") {
      open = {
        fence: { openLine: idx, indent: match[1], marker: match[2] },
        bodyLines: [],
      };
    } else if (match && match[3]) {
      genericFenceMarker = match[2];
    }
  }

  return fences;
}
