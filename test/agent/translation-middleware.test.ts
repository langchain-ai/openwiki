import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OpenWikiLocalShellBackend } from "../../src/agent/docs-only-backend.ts";
import {
  createWikiTranslationMiddleware,
  resolveTranslationPlan,
  type TranslationPlan,
} from "../../src/agent/translation-middleware.ts";

/**
 * A translate-all plan (a real language switch) into the given target.
 */
function switchTo(target: string, source = "en"): TranslationPlan {
  return { target, source, translateAll: true };
}

/**
 * A plain-update plan that only sweeps pages left pending, never a full pass.
 */
function sweep(language: string): TranslationPlan {
  return { target: language, source: language, translateAll: false };
}

/**
 * Records every prompt the middleware sends and returns a scripted translation
 * for each page body, without any network access.
 */
function fakeModel(translate: (content: string) => string) {
  const calls: { system: string; human: string; tags: string[] }[] = [];
  const asText = (message: BaseMessage): string =>
    typeof message.content === "string" ? message.content : "";
  const model = {
    invoke: (messages: BaseMessage[], options?: { tags?: string[] }) => {
      const [system, human] = messages;
      calls.push({
        system: asText(system),
        human: asText(human),
        tags: options?.tags ?? [],
      });
      return Promise.resolve(new AIMessage(translate(asText(human))));
    },
  };
  return { model: model as unknown as BaseChatModel, calls };
}

async function setup(outputMode: "local-wiki" | "repository" = "repository") {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-translate-"));
  const backend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    outputMode,
    rootDir,
    virtualMode: true,
  });
  return { backend, rootDir };
}

/**
 * Invokes a middleware's beforeAgent hook regardless of its exact shape.
 */
async function runBeforeAgent(
  middleware: ReturnType<typeof createWikiTranslationMiddleware>,
): Promise<void> {
  const beforeAgent =
    typeof middleware.beforeAgent === "function"
      ? middleware.beforeAgent
      : middleware.beforeAgent?.hook;
  expect(beforeAgent).toBeTypeOf("function");
  await (beforeAgent as () => Promise<unknown>)();
}

describe("resolveTranslationPlan", () => {
  test("requests a full pass when an update switches to a different language", () => {
    expect(resolveTranslationPlan("update", "zh-CN", "en")).toEqual({
      target: "zh-CN",
      source: "en",
      translateAll: true,
    });
  });

  test("treats an absent persisted language as English", () => {
    expect(resolveTranslationPlan("update", "zh-CN", undefined)).toEqual({
      target: "zh-CN",
      source: "en",
      translateAll: true,
    });
  });

  test("does not switch for a region-only change with the same primary subtag", () => {
    expect(resolveTranslationPlan("update", "en-GB", "en")).toEqual({
      target: "en-GB",
      source: "en",
      translateAll: false,
    });
    expect(resolveTranslationPlan("update", "zh-TW", "zh-CN")).toEqual({
      target: "zh-TW",
      source: "zh-CN",
      translateAll: false,
    });
  });

  test("returns a marker-sweep plan for a plain update with no requested language", () => {
    // No switch, but still a plan so pending pages get retried, targeting the
    // persisted language (source and target match).
    expect(resolveTranslationPlan("update", undefined, "zh-CN")).toEqual({
      target: "zh-CN",
      source: "zh-CN",
      translateAll: false,
    });
    expect(resolveTranslationPlan("update", undefined, undefined)).toEqual({
      target: "en",
      source: "en",
      translateAll: false,
    });
  });

  test("never applies to non-update commands", () => {
    expect(resolveTranslationPlan("init", "zh-CN", "en")).toBeUndefined();
    expect(resolveTranslationPlan("chat", "zh-CN", "en")).toBeUndefined();
  });

  test("compares malformed language tags by their literal value", () => {
    // A tag Intl.Locale cannot parse must not crash plan resolution: primarySubtag
    // falls back to the raw tag, and the switch decision still resolves.
    expect(resolveTranslationPlan("update", "@@bad", "en")).toEqual({
      target: "@@bad",
      source: "en",
      translateAll: true,
    });
  });
});

describe("createWikiTranslationMiddleware beforeAgent", () => {
  test("uses the complete source page as the factual translation boundary", async () => {
    const { backend } = await setup();
    const page = "/openwiki/page.md";
    await backend.write(page, "# Page\n\nThe service starts.\n");
    const { model, calls } = fakeModel((content) => `TRANSLATED\n${content}`);

    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("zh-CN"),
        () => {},
        () => {},
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].human).toBe("# Page\n\nThe service starts.\n");
    expect(calls[0].system).toContain("Preserve every fact's meaning");
    expect(calls[0].system).not.toContain("Claims");
  });

  test("translates every visible Markdown page during a language switch", async () => {
    const { backend } = await setup();
    const freshPage = "/openwiki/fresh.md";
    const stalePage = "/openwiki/stale.md";
    const unresolvedPage = "/openwiki/unresolved.md";
    const untrackedPage = "/openwiki/untracked.md";
    const allPages = [freshPage, stalePage, unresolvedPage, untrackedPage];
    for (const page of allPages) {
      await backend.write(page, `# ${path.posix.basename(page)}\n`);
    }
    const { model, calls } = fakeModel((content) => `TRANSLATED\n${content}`);

    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("zh-CN"),
        () => {},
        () => {},
      ),
    );

    expect(calls.map((call) => call.human)).toEqual([
      "# fresh.md\n",
      "# stale.md\n",
      "# unresolved.md\n",
      "# untracked.md\n",
    ]);
  });

  test("persists a successful pending marker but not a refused marker write", async () => {
    const successful = await setup();
    const failed = await setup();
    const page = "/openwiki/page.md";
    for (const fixture of [successful, failed]) {
      await fixture.backend.write(page, "# Page\n\nBody.\n");
    }
    vi.spyOn(failed.backend, "edit").mockResolvedValue({
      error: "permission denied",
    });
    const brokenModel = {
      invoke: () => Promise.reject(new Error("translator unavailable")),
    } as unknown as BaseChatModel;

    await runBeforeAgent(
      createWikiTranslationMiddleware(
        successful.backend,
        "repository",
        brokenModel,
        switchTo("zh-CN"),
        () => {},
        () => {},
      ),
    );
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        failed.backend,
        "repository",
        brokenModel,
        switchTo("zh-CN"),
        () => {},
        () => {},
      ),
    );

    const successfulMarkdown = await readFile(
      path.join(successful.rootDir, "openwiki/page.md"),
      "utf8",
    );
    expect(successfulMarkdown).toContain("openwiki_translation_pending");
    await expect(
      readFile(path.join(failed.rootDir, "openwiki/page.md"), "utf8"),
    ).resolves.not.toContain("openwiki_translation_pending");
  });

  test("rewrites every eligible page and passes the original to the model", async () => {
    const { backend, rootDir } = await setup();
    await backend.write("/openwiki/quickstart.md", "# Quickstart\n\nHello.\n");
    await backend.write(
      "/openwiki/architecture/overview.md",
      "# Overview\n\nStructure.\n",
    );

    const { model, calls } = fakeModel((content) => `TRANSLATED\n${content}`);
    const middleware = createWikiTranslationMiddleware(
      backend,
      "repository",
      model,
      switchTo("zh-CN"),
    );
    await runBeforeAgent(middleware);

    await expect(
      readFile(path.join(rootDir, "openwiki/quickstart.md"), "utf8"),
    ).resolves.toBe("TRANSLATED\n# Quickstart\n\nHello.\n");
    await expect(
      readFile(path.join(rootDir, "openwiki/architecture/overview.md"), "utf8"),
    ).resolves.toBe("TRANSLATED\n# Overview\n\nStructure.\n");

    // The model saw each page's original content and a prompt naming both langs.
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.human).sort()).toEqual([
      "# Overview\n\nStructure.\n",
      "# Quickstart\n\nHello.\n",
    ]);
    expect(calls[0].system).toContain("Chinese (China)");
    expect(calls[0].system).toContain("English");
    // The front matter instruction covers the human-readable title,
    // description, and type values, so no reader-facing value is left in the
    // source language.
    expect(calls[0].system).toContain('"title", "description", and "type"');
    // The field rule must dominate the "keep technical terms unchanged" rule, or
    // a technical-term-dense description gets left in the source language.
    expect(calls[0].system).toContain(
      "dense with product names, feature names, or technical terminology",
    );
    // Tags are a cross-cutting aggregation key, so they stay canonical: the
    // prompt tells the model to leave the tags values in English.
    expect(calls[0].system).toContain('Leave the "tags" values in English');
    // Every translation call is tagged so its tokens are excluded from the
    // agent's messages stream and never scroll past in the TUI.
    for (const call of calls) {
      expect(call.tags).toContain("langsmith:nostream");
    }
  });

  test("announces the pass once when at least one page is translated", async () => {
    const { backend } = await setup();
    await backend.write("/openwiki/one.md", "# One\n\nBody.\n");
    await backend.write("/openwiki/two.md", "# Two\n\nBody.\n");

    const status: string[] = [];
    const { model } = fakeModel((content) => `T\n${content}`);
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("zh-CN"),
        () => {},
        (message) => status.push(message),
      ),
    );

    // A single line for the whole pass, not one per page.
    expect(status).toEqual(["Translating wiki docs..."]);
  });

  test("stays silent on a no-op sweep with nothing to translate", async () => {
    const { backend } = await setup();
    await backend.write("/openwiki/one.md", "# One\n\nBody.\n");

    const status: string[] = [];
    const { model, calls } = fakeModel((content) => `T\n${content}`);
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        sweep("en"),
        () => {},
        (message) => status.push(message),
      ),
    );

    // No pending pages means no model calls and no announcement.
    expect(calls).toHaveLength(0);
    expect(status).toEqual([]);
  });

  test("keeps translating other pages when one page's write fails and reports it", async () => {
    const { backend, rootDir } = await setup();
    await backend.write("/openwiki/good.md", "# Good\n\nBody.\n");
    await backend.write("/openwiki/bad.md", "# Bad\n\nBody.\n");

    // Fail every write for one page only; the others must still convert. Both the
    // translation write and the retry-stamp write are refused here.
    const realEdit = backend.edit.bind(backend);
    vi.spyOn(backend, "edit").mockImplementation((filePath, before, after) =>
      filePath.endsWith("bad.md")
        ? Promise.resolve({ error: "disk on fire" })
        : realEdit(filePath, before, after),
    );

    const warnings: string[] = [];
    const { model } = fakeModel((content) => `T\n${content}`);
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("zh-CN"),
        (message) => warnings.push(message),
      ),
    );

    // The healthy page was still translated despite the sibling failure.
    await expect(
      readFile(path.join(rootDir, "openwiki/good.md"), "utf8"),
    ).resolves.toBe("T\n# Good\n\nBody.\n");
    // The failing page is left untouched and named in a single warning.
    await expect(
      readFile(path.join(rootDir, "openwiki/bad.md"), "utf8"),
    ).resolves.toBe("# Bad\n\nBody.\n");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bad.md");
    expect(warnings[0]).toContain("disk on fire");
  });

  test("stamps a page for retry when the model fails to translate it", async () => {
    const { backend, rootDir } = await setup();
    await backend.write("/openwiki/good.md", "# Good\n\nBody.\n");
    await backend.write("/openwiki/bad.md", "# Bad\n\nBody.\n");

    // The model translates every page except the one whose body mentions "Bad".
    const model = {
      invoke: (messages: BaseMessage[]) => {
        const human = messages[1];
        const text = typeof human.content === "string" ? human.content : "";
        return text.includes("# Bad")
          ? Promise.reject(new Error("model exploded"))
          : Promise.resolve(new AIMessage(`T\n${text}`));
      },
    } as unknown as BaseChatModel;

    const warnings: string[] = [];
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("zh-CN"),
        (message) => warnings.push(message),
      ),
    );

    // The healthy page converts; the failed one keeps its body but gains a
    // pending marker carrying the target language, so a later update retries it.
    await expect(
      readFile(path.join(rootDir, "openwiki/good.md"), "utf8"),
    ).resolves.toBe("T\n# Good\n\nBody.\n");
    const bad = await readFile(path.join(rootDir, "openwiki/bad.md"), "utf8");
    expect(bad).toContain('openwiki_translation_pending: "zh-CN"');
    expect(bad).toContain("# Bad");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bad.md");
    expect(warnings[0]).toContain("model exploded");
  });

  test("on a plain update, retries only pending pages and clears the marker", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/settled.md",
      '---\ntype: "参考"\ntitle: "已完成"\n---\n\n# 已完成\n',
    );
    await backend.write(
      "/openwiki/pending.md",
      '---\ntype: "参考"\ntitle: "待翻译"\nopenwiki_translation_pending: "zh-CN"\n---\n\n# 待翻译\n',
    );

    // Identity model: the pending page is already in the target language, so a
    // successful pass only needs to strip its marker.
    const { model, calls } = fakeModel((content) => content);
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        sweep("zh-CN"),
      ),
    );

    // Only the pending page was sent to the model; the settled page was skipped.
    expect(calls).toHaveLength(1);
    expect(calls[0].human).toContain("待翻译");

    // The settled page is byte-for-byte unchanged.
    await expect(
      readFile(path.join(rootDir, "openwiki/settled.md"), "utf8"),
    ).resolves.toBe('---\ntype: "参考"\ntitle: "已完成"\n---\n\n# 已完成\n');
    // The marker is cleared while the rest of the front matter survives.
    const pending = await readFile(
      path.join(rootDir, "openwiki/pending.md"),
      "utf8",
    );
    expect(pending).not.toContain("openwiki_translation_pending");
    expect(pending).toContain('type: "参考"');
    expect(pending).toContain('title: "待翻译"');
  });

  test("on a plain update with no pending pages, calls the model zero times", async () => {
    const { backend } = await setup();
    await backend.write("/openwiki/one.md", "# One\n\nBody.\n");
    await backend.write("/openwiki/two.md", "# Two\n\nBody.\n");

    const edit = vi.spyOn(backend, "edit");
    const { model, calls } = fakeModel((content) => `X\n${content}`);
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        sweep("en"),
      ),
    );

    expect(calls).toHaveLength(0);
    expect(edit).not.toHaveBeenCalled();
  });

  test("skips indexes, logs, control files, and dotfiles", async () => {
    const { backend, rootDir } = await setup();
    const dir = path.join(rootDir, "openwiki");
    await mkdir(path.join(dir, ".hidden"), { recursive: true });
    await backend.write("/openwiki/page.md", "# Page\n\nBody.\n");
    for (const name of ["index.md", "log.md", "INSTRUCTIONS.md"]) {
      await writeFile(path.join(dir, name), "# Control\n\nBody.\n");
    }
    await writeFile(path.join(dir, ".secret.md"), "# Secret\n\nBody.\n");
    await writeFile(path.join(dir, ".hidden", "buried.md"), "# Buried\n");

    const { model, calls } = fakeModel((content) => `X\n${content}`);
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("hi"),
      ),
    );

    // Only the one real concept page is translated.
    expect(calls).toHaveLength(1);
    expect(calls[0].human).toBe("# Page\n\nBody.\n");
    await expect(readFile(path.join(dir, "index.md"), "utf8")).resolves.toBe(
      "# Control\n\nBody.\n",
    );
    await expect(readFile(path.join(dir, ".secret.md"), "utf8")).resolves.toBe(
      "# Secret\n\nBody.\n",
    );
  });

  test("does not write a page whose translation is unchanged", async () => {
    const { backend } = await setup();
    await backend.write("/openwiki/page.md", "# Page\n\nBody.\n");

    const edit = vi.spyOn(backend, "edit");
    const { model } = fakeModel((content) => content);
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("zh-CN"),
      ),
    );

    expect(edit).not.toHaveBeenCalled();
  });

  test("translates from the local-wiki root", async () => {
    const { backend, rootDir } = await setup("local-wiki");
    await backend.write("/note.md", "# Note\n\nBody.\n");

    const { model } = fakeModel((content) => `[hi] ${content}`);
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "local-wiki",
        model,
        switchTo("hi"),
      ),
    );

    await expect(readFile(path.join(rootDir, "note.md"), "utf8")).resolves.toBe(
      "[hi] # Note\n\nBody.\n",
    );
  });

  test("is a no-op when the wiki root is missing", async () => {
    const { backend } = await setup("repository");
    const { model, calls } = fakeModel((content) => `X\n${content}`);

    await expect(
      runBeforeAgent(
        createWikiTranslationMiddleware(
          backend,
          "repository",
          model,
          switchTo("zh-CN"),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("treats a directory listing error as an empty tree", async () => {
    const { backend } = await setup();
    await backend.write("/openwiki/page.md", "# Page\n\nBody.\n");
    // A backend that cannot enumerate the root yields no files rather than
    // throwing, so the run degrades to translating nothing.
    vi.spyOn(backend, "ls").mockResolvedValue({ error: "no such dir" });

    const { model, calls } = fakeModel((content) => `T\n${content}`);
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("zh-CN"),
      ),
    );

    expect(calls).toHaveLength(0);
  });

  test("skips a page whose content is only whitespace", async () => {
    const { backend } = await setup();
    await backend.write("/openwiki/blank.md", "   \n");

    const { model, calls } = fakeModel((content) => `T\n${content}`);
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("zh-CN"),
      ),
    );

    // An empty page has no prose to translate, so the model is never called.
    expect(calls).toHaveLength(0);
  });

  test("stamps a page for retry when the model returns an empty translation", async () => {
    const { backend, rootDir } = await setup();
    await backend.write("/openwiki/page.md", "# Page\n\nBody.\n");

    const warnings: string[] = [];
    // A blank model response is a failure, not a valid translation: writing it
    // would erase the page, so the page must be kept and flagged for retry.
    const { model } = fakeModel(() => "   ");
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("zh-CN"),
        (message) => warnings.push(message),
      ),
    );

    const after = await readFile(
      path.join(rootDir, "openwiki/page.md"),
      "utf8",
    );
    expect(after).toContain('openwiki_translation_pending: "zh-CN"');
    expect(after).toContain("# Page");
    expect(warnings[0]).toContain("empty translation");
  });

  test("does not rewrite the pending marker when it already matches", async () => {
    const { backend, rootDir } = await setup();
    // The page is already stamped for exactly this target, so a failed retry must
    // not rewrite an identical marker or report a bogus stamp failure.
    await backend.write(
      "/openwiki/page.md",
      '---\nopenwiki_translation_pending: "zh-CN"\n---\n\n# Body\n',
    );

    const warnings: string[] = [];
    const model = {
      invoke: () => Promise.reject(new Error("model down")),
    } as unknown as BaseChatModel;
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("zh-CN"),
        (message) => warnings.push(message),
      ),
    );

    const after = await readFile(
      path.join(rootDir, "openwiki/page.md"),
      "utf8",
    );
    expect(after).toContain('openwiki_translation_pending: "zh-CN"');
    // markPending was a no-op, so the warning names only the model failure, not a
    // retry-stamp failure.
    expect(warnings[0]).toContain("model down");
    expect(warnings[0]).not.toContain("could not mark it for retry");
  });

  test("reports an unreadable page through the default stderr warning", async () => {
    const { backend } = await setup();
    await backend.write("/openwiki/page.md", "# Page\n\nBody.\n");
    // A read failure is caught per page; with no onWarning supplied the default
    // sink writes the (secret-redacted) summary to stderr.
    vi.spyOn(backend, "readRaw").mockResolvedValue({
      error: "permission denied",
    });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const { model, calls } = fakeModel((content) => `T\n${content}`);
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("zh-CN"),
      ),
    );

    expect(calls).toHaveLength(0);
    const written = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(written).toContain("page.md");
    expect(written).toContain("permission denied");
  });

  test("stamps a page whose backend content is not text", async () => {
    const { backend } = await setup();
    await backend.write("/openwiki/page.md", "# Page\n\nBody.\n");
    // A non-string, non-array payload is not translatable prose; the page is
    // reported and skipped rather than coerced.
    vi.spyOn(backend, "readRaw").mockResolvedValue({
      data: { content: 42 as unknown as string },
    });

    const warnings: string[] = [];
    const { model } = fakeModel((content) => `T\n${content}`);
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("zh-CN"),
        (message) => warnings.push(message),
      ),
    );

    expect(warnings[0]).toContain("not a text file");
  });

  test("joins array-shaped file content into text before translating", async () => {
    const { backend, rootDir } = await setup();
    await backend.write("/openwiki/page.md", "# A\n\nB\n");
    // A backend that returns line arrays must be flattened to a single string so
    // the join round-trips the original file content and the edit applies.
    vi.spyOn(backend, "readRaw").mockResolvedValue({
      data: { content: ["# A", "", "B", ""] },
    });

    const { model, calls } = fakeModel((content) => `T\n${content}`);
    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("zh-CN"),
      ),
    );

    expect(calls[0].human).toBe("# A\n\nB\n");
    await expect(
      readFile(path.join(rootDir, "openwiki/page.md"), "utf8"),
    ).resolves.toBe("T\n# A\n\nB\n");
  });

  test("flattens array model output, keeping text blocks and dropping the rest", async () => {
    const { backend, rootDir } = await setup();
    await backend.write("/openwiki/page.md", "# Page\n\nBody.\n");
    // The model may answer with structured content blocks; only text blocks (and
    // bare strings) contribute, non-text blocks are ignored.
    const model = {
      invoke: () =>
        Promise.resolve({
          content: [
            "raw ",
            { type: "text", text: "translated" },
            { type: "image_url", image_url: "ignored" },
          ],
        }),
    } as unknown as BaseChatModel;

    await runBeforeAgent(
      createWikiTranslationMiddleware(
        backend,
        "repository",
        model,
        switchTo("zh-CN"),
      ),
    );

    await expect(
      readFile(path.join(rootDir, "openwiki/page.md"), "utf8"),
    ).resolves.toBe("raw translated");
  });

  test("renders a language with no display name as its bare tag in the prompt", async () => {
    const { backend } = await setup();
    await backend.write("/openwiki/page.md", "# Page\n\nBody.\n");
    // describeLanguage must not throw on a tag Intl cannot name; it falls back to
    // the raw tag so the translation prompt is still well-formed.
    const { model, calls } = fakeModel((content) => `T\n${content}`);
    await runBeforeAgent(
      createWikiTranslationMiddleware(backend, "repository", model, {
        target: "@@bad",
        source: "en",
        translateAll: true,
      }),
    );

    expect(calls[0].system).toContain("@@bad");
  });
});
