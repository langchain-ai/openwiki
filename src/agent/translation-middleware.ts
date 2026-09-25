import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { MessageContent } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BackendProtocolV2, FileInfo } from "deepagents";
import { createMiddleware } from "langchain";
import path from "node:path";
import { getErrorMessage } from "../platform/diagnostics.js";
import { getPrimaryLanguageSubtag } from "../platform/language.js";
import {
  OPENWIKI_TRANSLATION_PENDING_FIELD,
  readFrontmatterField,
  removeFrontmatterField,
  setFrontmatterField,
} from "../okf/frontmatter.js";
import type { OpenWikiCommand, OpenWikiOutputMode } from "./types.js";

/**
 * Wiki files that are regenerated deterministically (indexes) or are not
 * human-facing prose (logs, scratch plans, the user brief), so they are never
 * translated.
 */
const EXCLUDED_FILES = new Set(["index.md", "log.md", "INSTRUCTIONS.md"]);

/**
 * LangGraph run tag that excludes a model call from the `messages` stream mode.
 *
 * The agent is driven with `messages`-mode streaming, which captures every LLM
 * token in the graph, including the translation calls this middleware makes in
 * `beforeAgent`. Tagging those calls keeps their raw translated Markdown out of
 * the token stream so it never scrolls past in the TUI; LangGraph honors this tag
 * (and the bare `nostream`) when deciding which runs to surface.
 */
const NOSTREAM_TAG = "langsmith:nostream";

/**
 * Single friendly line shown once while the wiki is being translated, in place
 * of the suppressed per-token translation output.
 */
const TRANSLATION_STATUS_MESSAGE = "Translating wiki docs...";

/**
 * What an `update` run should do about the wiki's language before the agent
 * runs.
 *
 * The plan is resolved once per run and drives the translation middleware: it
 * says which language every page must end up in, which language to translate
 * from, and whether the whole wiki needs converting or only pages a prior run
 * left pending.
 */
export interface TranslationPlan {
  /**
   * The language every eligible page must end up written in, as a canonical
   * BCP-47 tag (for example `en` or `zh-CN`).
   */
  target: string;

  /**
   * The language the wiki is currently written in, used as the translation
   * source hint. Detection is best-effort: a page left pending by an earlier
   * failed switch may not actually be in this language, so the model is asked to
   * detect the real source rather than trust this blindly.
   */
  source: string;

  /**
   * When true the run must translate every page (a real language switch); when
   * false only pages carrying a pending-translation marker are retranslated, and
   * a wiki with none is left untouched.
   */
  translateAll: boolean;
}

/**
 * Resolves the translation plan for a run, or undefined when translation never
 * applies (any command other than `update`).
 *
 * OpenWiki treats the wiki's language as persisted state: an `update` inherits
 * it unless `--language` requests a different one. The target is the requested
 * language, else the persisted one, else English. A full translate-all pass is
 * warranted only when a language is explicitly requested whose primary subtag
 * differs from the persisted one; comparing primary subtags avoids a needless
 * retranslation for a region-only change such as `en` to `en-GB`. Even without a
 * switch the plan is returned for every update so the middleware can still sweep
 * pages a prior run left pending.
 */
export function resolveTranslationPlan(
  command: OpenWikiCommand,
  requestedLanguage: string | undefined,
  currentWikiLanguage: string | undefined,
): TranslationPlan | undefined {
  if (command !== "update") {
    return undefined;
  }

  const source = currentWikiLanguage ?? "en";
  return {
    target: requestedLanguage ?? source,
    source,
    translateAll:
      requestedLanguage !== undefined &&
      getPrimaryLanguageSubtag(requestedLanguage) !==
        getPrimaryLanguageSubtag(currentWikiLanguage),
  };
}

/**
 * Creates middleware that brings every existing wiki page into the run's target
 * language before the agent runs.
 *
 * OpenWiki treats the wiki's language as persisted state, so an incremental
 * update alone would leave a mix of the old and new language on a switch, since
 * the agent only rewrites pages whose source changed. This `beforeAgent` hook
 * closes that gap. It is mounted on every `update` and does one of three things,
 * cheapest first: with nothing to do it only walks the tree (zero model calls);
 * on a plain update it retranslates just the pages a prior run left marked
 * `openwiki_translation_pending`; on a real language switch it retranslates every
 * page.
 *
 * The model's output is treated purely as file text and written back through the
 * sandboxed docs-only backend; it is never executed, and every path comes from
 * backend enumeration rather than model output.
 *
 * A single page's translation failure never aborts the run: the page is left in
 * its previous language, stamped with a pending marker so the next update retries
 * it, and reported through `onWarning`. `onWarning` defaults to writing the
 * (already secret-redacted) summary to stderr.
 *
 * The raw translated Markdown is kept out of the token stream (see
 * {@link NOSTREAM_TAG}); `onStatus` is called once instead, with a short line
 * announcing the pass, so the user sees progress without the flood of tokens. It
 * fires only when at least one page is actually translated, so a no-op marker
 * sweep stays silent, and defaults to writing the line to stderr.
 *
 * @param backend - Sandboxed wiki backend.
 * @param outputMode - Current output target.
 * @param model - Translation model.
 * @param plan - Resolved language transition.
 * @param onWarning - Sanitized warning sink.
 * @param onStatus - User-visible status sink.
 * @returns Translation middleware.
 */
export function createWikiTranslationMiddleware(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
  model: BaseChatModel,
  plan: TranslationPlan,
  onWarning: (message: string) => void = (message) => {
    process.stderr.write(`${message}\n`);
  },
  onStatus: (message: string) => void = (message) => {
    process.stderr.write(`${message}\n`);
  },
) {
  return createMiddleware({
    name: "OpenWikiTranslationMiddleware",
    beforeAgent: async () => {
      await translateWiki(
        backend,
        outputMode,
        model,
        plan,
        onWarning,
        onStatus,
      );
    },
  });
}

/**
 * Brings each concept page into the plan's target language.
 *
 * Each page is handled independently: a plain update skips pages that are not
 * marked pending, and any failure (a model or backend error) is caught, the page
 * is stamped for retry, and the run continues rather than aborting. All failures
 * are reported once through `onWarning`, so a single bad page degrades the update
 * gracefully instead of crashing it. `onStatus` announces the pass once, lazily,
 * just before the first page is translated, so a sweep that finds nothing to do
 * prints no status at all.
 *
 * @param backend - Sandboxed wiki backend.
 * @param outputMode - Current output target.
 * @param model - Translation model.
 * @param plan - Resolved language transition.
 * @param onWarning - Sanitized warning sink.
 * @param onStatus - User-visible status sink.
 */
async function translateWiki(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
  model: BaseChatModel,
  plan: TranslationPlan,
  onWarning: (message: string) => void,
  onStatus: (message: string) => void,
): Promise<void> {
  const root = outputMode === "local-wiki" ? "/" : "/openwiki";
  const failures: string[] = [];
  let announced = false;

  for (const filePath of await collectMarkdownFiles(backend, root)) {
    let content: string;
    try {
      content = await readText(backend, filePath);
    } catch (error) {
      // getErrorMessage redacts any provider credential an error may carry
      // before the path and reason reach stderr or the TUI.
      failures.push(`- ${filePath}: ${getErrorMessage(error)}`);
      continue;
    }

    // On a plain update only retry pages a prior run left pending; a real switch
    // retranslates every page.
    const pending =
      readFrontmatterField(content, OPENWIKI_TRANSLATION_PENDING_FIELD) !==
      undefined;
    if (!plan.translateAll && !pending) continue;

    // Announce the pass on the first page that will actually be translated, so a
    // no-op sweep stays silent and the raw token stream stays suppressed.
    if (!announced) {
      onStatus(TRANSLATION_STATUS_MESSAGE);
      announced = true;
    }

    try {
      await translatePage(backend, model, filePath, content, plan);
    } catch (error) {
      const reasons = [getErrorMessage(error)];
      const stampError = await markPending(
        backend,
        filePath,
        content,
        plan.target,
      );
      if (stampError) {
        reasons.push(`could not mark it for retry: ${stampError}`);
      }
      failures.push(`- ${filePath}: ${reasons.join("; ")}`);
    }
  }

  if (failures.length > 0) {
    onWarning(
      `OpenWiki could not translate ${failures.length} page(s) into ` +
        `${describeLanguage(plan.target)}; they keep their previous language ` +
        `and will be retried on the next update:\n${failures.join("\n")}`,
    );
  }
}

/**
 * Translates one concept page into the plan's target language and clears any
 * pending marker on success, writing only when the content changed.
 *
 * Throws on a model or backend failure, and on empty model output, so the caller
 * can stamp the page for retry. A successful translation always drops the pending
 * marker deterministically, whatever the model returned, so a page that has just
 * been converted is never left flagged.
 *
 * @param backend - Sandboxed wiki backend.
 * @param model - Translation model.
 * @param filePath - Canonical virtual Markdown path.
 * @param original - Current Markdown.
 * @param plan - Resolved language transition.
 */
async function translatePage(
  backend: BackendProtocolV2,
  model: BaseChatModel,
  filePath: string,
  original: string,
  plan: TranslationPlan,
): Promise<void> {
  if (!original.trim()) return;

  const translated = await translateMarkdown(
    model,
    original,
    plan.source,
    plan.target,
  );
  if (!translated.trim()) {
    throw new Error("the model returned an empty translation");
  }

  const finalized = removeFrontmatterField(
    translated,
    OPENWIKI_TRANSLATION_PENDING_FIELD,
  );
  if (finalized === original) return;

  const result = await backend.edit(filePath, original, finalized);
  if (result.error) {
    throw new Error(`could not write the translation: ${result.error}`);
  }
}

/**
 * Stamps a page with the pending-translation marker so a later update retries
 * it, preserving all other front matter.
 *
 * Returns undefined on success (including when the marker already matched and no
 * write was needed), or a sanitized reason string when the stamp could not be
 * written, so the caller can fold it into the surrounding failure report rather
 * than swallow it.
 */
async function markPending(
  backend: BackendProtocolV2,
  filePath: string,
  content: string,
  target: string,
): Promise<string | undefined> {
  const stamped = setFrontmatterField(
    content,
    OPENWIKI_TRANSLATION_PENDING_FIELD,
    target,
  );
  if (stamped === content) return undefined;

  const result = await backend.edit(filePath, content, stamped);
  return result.error ? getErrorMessage(new Error(result.error)) : undefined;
}

/**
 * Asks the model to translate a Markdown document, returning its raw text.
 *
 * The call is tagged with {@link NOSTREAM_TAG} so its tokens are excluded from
 * the agent's `messages` stream: the translated Markdown is written back through
 * the backend rather than streamed to the TUI token by token.
 *
 * @param model - Translation model.
 * @param content - Markdown to translate.
 * @param from - Expected source language.
 * @param to - Required target language.
 * @returns Raw translated Markdown.
 */
async function translateMarkdown(
  model: BaseChatModel,
  content: string,
  from: string,
  to: string,
): Promise<string> {
  const response = await model.invoke(
    [
      new SystemMessage(buildTranslationPrompt(from, to)),
      new HumanMessage(content),
    ],
    { tags: [NOSTREAM_TAG] },
  );
  return extractText(response.content);
}

/**
 * Builds the system instruction that constrains the translation to prose while
 * preserving Markdown structure and code.
 *
 * The source language is a hint, not a guarantee: a page left pending by an
 * earlier failed switch may still be in a different language, so the model is
 * told to detect the real source and to leave content already in the target
 * language unchanged.
 *
 * @param from - Expected source language.
 * @param to - Required target language.
 * @returns Translation system prompt.
 */
function buildTranslationPrompt(from: string, to: string): string {
  return `You are a professional technical translator for a software documentation wiki.
Translate the Markdown document provided by the user into ${describeLanguage(
    to,
  )}. It is expected to be in ${describeLanguage(
    from,
  )}, but detect its actual language and translate any content that is not already in ${describeLanguage(
    to,
  )}. If the document is already entirely in ${describeLanguage(
    to,
  )}, return it unchanged.

Rules:
- Translate prose, headings, list items, blockquotes, and table cell text.
- In the YAML front matter, fully translate the human-readable "title", "description", and "type" values, even when they are dense with product names, feature names, or technical terminology; within those values keep unchanged only literal code identifiers, file paths, commands, and URLs. Leave the "tags" values in English so they stay stable across pages as cross-cutting aggregation keys. Keep every front matter key as written, and copy all other values (URLs, file paths, identifiers, timestamps) byte-for-byte.
- Do NOT translate code identifiers, file paths, commands, API names, URLs, or anything inside inline code spans or fenced code blocks.
- Preserve all Markdown syntax, link targets, mermaid fences, and the document's whitespace and structure.
- Preserve every fact's meaning. Do not introduce, omit, strengthen, weaken, or contradict a material fact.
- Return ONLY the translated document text, with no explanation, commentary, or surrounding code fences.
`;
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
