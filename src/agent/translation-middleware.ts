import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { MessageContent } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BackendProtocolV2, FileInfo } from "deepagents";
import { createMiddleware } from "langchain";
import path from "node:path";
import type { OpenWikiCommand, OpenWikiOutputMode } from "./types.js";

/**
 * Wiki files that are regenerated deterministically (indexes) or are not
 * human-facing prose (logs, scratch plans), so they are never translated.
 */
const EXCLUDED_FILES = new Set([
  "index.md",
  "log.md",
  "_plan.md",
  "INSTRUCTIONS.md",
]);

/**
 * The source and target languages for a translate-all pass, as canonical
 * BCP-47 tags (for example `en` and `zh-CN`).
 */
export interface WikiTranslationOptions {
  /**
   * The language the wiki is currently written in.
   */
  from: string;

  /**
   * The language every page should be rewritten into.
   */
  to: string;
}

/**
 * Decides whether a run must retranslate the existing wiki, and between which
 * languages.
 *
 * A translate-all pass is warranted only for an `update` that explicitly
 * requests a language whose primary subtag differs from the wiki's persisted
 * one (an absent persisted language means the wiki is English). Comparing
 * primary subtags avoids a needless full retranslation for a region-only change
 * such as `en` to `en-GB`. Returns the source and target languages when a switch
 * is needed, or `undefined` otherwise.
 */
export function resolveTranslationSwitch(
  command: OpenWikiCommand,
  requestedLanguage: string | undefined,
  currentWikiLanguage: string | undefined,
): WikiTranslationOptions | undefined {
  if (command !== "update" || requestedLanguage === undefined) {
    return undefined;
  }
  if (primarySubtag(requestedLanguage) === primarySubtag(currentWikiLanguage)) {
    return undefined;
  }
  return { from: currentWikiLanguage ?? "en", to: requestedLanguage };
}

/**
 * Returns a language tag's primary subtag (for example `zh` for `zh-CN`),
 * treating an absent wiki language as English.
 */
function primarySubtag(tag: string | undefined): string {
  if (!tag) return "en";
  try {
    return new Intl.Locale(tag).language;
  } catch {
    return tag;
  }
}

/**
 * Creates middleware that retranslates every existing wiki page before the
 * agent runs.
 *
 * OpenWiki treats the wiki's language as persisted state: an update inherits it
 * unless `--language` requests a different one. When it differs, the agent's
 * incremental update alone would leave a mix of the old and new language, since
 * it only rewrites pages whose source changed. This `beforeAgent` hook closes
 * that gap by walking the wiki up front and rewriting each page into the target
 * language, so the agent then edits an already-uniform wiki.
 *
 * The model's output is treated purely as file text and written back through
 * the sandboxed docs-only backend; it is never executed, and every path comes
 * from backend enumeration rather than model output.
 */
export function createWikiTranslationMiddleware(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
  model: BaseChatModel,
  languages: WikiTranslationOptions,
) {
  return createMiddleware({
    name: "OpenWikiTranslationMiddleware",
    beforeAgent: async () => {
      await translateWiki(backend, outputMode, model, languages);
    },
  });
}

/**
 * Rewrites every concept page in the wiki from one language into another.
 */
async function translateWiki(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
  model: BaseChatModel,
  languages: WikiTranslationOptions,
): Promise<void> {
  const root = outputMode === "local-wiki" ? "/" : "/openwiki";
  for (const filePath of await collectMarkdownFiles(backend, root)) {
    await translateFile(backend, model, filePath, languages);
  }
}

/**
 * Translates one concept file in place, skipping writes that would not change
 * the content.
 */
async function translateFile(
  backend: BackendProtocolV2,
  model: BaseChatModel,
  filePath: string,
  languages: WikiTranslationOptions,
): Promise<void> {
  const original = await readText(backend, filePath);
  if (!original.trim()) return;

  const translated = await translateMarkdown(model, original, languages);
  if (!translated.trim() || translated.trim() === original.trim()) return;

  const result = await backend.edit(filePath, original, translated);
  if (result.error) {
    throw new Error(`Unable to translate ${filePath}: ${result.error}`);
  }
}

/**
 * Asks the model to translate a Markdown document, returning its raw text.
 */
async function translateMarkdown(
  model: BaseChatModel,
  content: string,
  { from, to }: WikiTranslationOptions,
): Promise<string> {
  const response = await model.invoke([
    new SystemMessage(buildTranslationPrompt(from, to)),
    new HumanMessage(content),
  ]);
  return extractText(response.content);
}

/**
 * Builds the system instruction that constrains the translation to prose while
 * preserving Markdown structure and code.
 */
function buildTranslationPrompt(from: string, to: string): string {
  return `You are a professional technical translator for a software documentation wiki.
Translate the Markdown document provided by the user from ${describeLanguage(
    from,
  )} into ${describeLanguage(to)}.

Rules:
- Translate prose, headings, list items, blockquotes, and table cell text.
- In the YAML front matter, translate the human-readable "title", "description", "type", and "tags" values. Keep every front matter key and all other values (URLs, file paths, identifiers, timestamps) byte-for-byte unchanged.
- Do NOT translate code identifiers, file paths, commands, API names, URLs, or anything inside inline code spans or fenced code blocks.
- Preserve all Markdown syntax, link targets, mermaid fences, and the document's whitespace and structure.
- Return ONLY the translated document text, with no explanation, commentary, or surrounding code fences.`;
}

/**
 * Renders a language tag for the prompt as its English display name (which
 * already includes any region, for example "Chinese (China)"), falling back to
 * the bare tag when no name is known.
 */
function describeLanguage(tag: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(tag);
    if (name && name.toLowerCase() !== tag.toLowerCase()) {
      return name;
    }
  } catch {
    // Malformed tag: fall through to the bare tag.
  }
  return tag;
}

/**
 * Flattens model message content into plain text, joining any content blocks.
 */
function extractText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((block) =>
      typeof block === "string"
        ? block
        : block.type === "text"
          ? block.text
          : "",
    )
    .join("");
}

/**
 * Recursively collects visible, translatable Markdown files under a directory.
 */
async function collectMarkdownFiles(
  backend: BackendProtocolV2,
  directoryPath: string,
): Promise<string[]> {
  const result = await backend.ls(directoryPath);
  if (result.error) return [];

  const files: string[] = [];
  for (const entry of result.files ?? []) {
    const name = entryName(entry);
    if (!name || name.startsWith(".")) continue;

    const entryPath = path.posix.join(directoryPath, name);
    if (entry.is_dir) {
      files.push(...(await collectMarkdownFiles(backend, entryPath)));
      continue;
    }
    if (
      path.posix.extname(name).toLowerCase() === ".md" &&
      !EXCLUDED_FILES.has(name)
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * Reads a text file from the backend or throws an actionable error.
 */
async function readText(
  backend: BackendProtocolV2,
  filePath: string,
): Promise<string> {
  const result = await backend.readRaw(filePath);
  if (result.error) {
    throw new Error(`Unable to read ${filePath}: ${result.error}`);
  }

  const content = result.data?.content;
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
