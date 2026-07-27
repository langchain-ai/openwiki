import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import {
  createWikiTranslationMiddleware,
  resolveTranslationPlan,
  type TranslationPlan,
} from "../src/agent/translation-middleware.ts";

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
});

describe("createWikiTranslationMiddleware beforeAgent", () => {
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
    for (const name of ["index.md", "log.md", "_plan.md", "INSTRUCTIONS.md"]) {
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
});
