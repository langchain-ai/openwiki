import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import {
  createWikiTranslationMiddleware,
  resolveTranslationSwitch,
} from "../src/agent/translation-middleware.ts";

/**
 * Records every prompt the middleware sends and returns a scripted translation
 * for each page body, without any network access.
 */
function fakeModel(translate: (content: string) => string) {
  const calls: { system: string; human: string }[] = [];
  const asText = (message: BaseMessage): string =>
    typeof message.content === "string" ? message.content : "";
  const model = {
    invoke: (messages: BaseMessage[]) => {
      const [system, human] = messages;
      calls.push({ system: asText(system), human: asText(human) });
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

describe("resolveTranslationSwitch", () => {
  test("triggers when an update requests a different language", () => {
    expect(resolveTranslationSwitch("update", "zh-CN", "en")).toEqual({
      from: "en",
      to: "zh-CN",
    });
  });

  test("treats an absent persisted language as English", () => {
    expect(resolveTranslationSwitch("update", "zh-CN", undefined)).toEqual({
      from: "en",
      to: "zh-CN",
    });
    expect(
      resolveTranslationSwitch("update", "en-US", undefined),
    ).toBeUndefined();
  });

  test("ignores a region-only change with the same primary subtag", () => {
    expect(resolveTranslationSwitch("update", "en-GB", "en")).toBeUndefined();
    expect(
      resolveTranslationSwitch("update", "zh-TW", "zh-CN"),
    ).toBeUndefined();
  });

  test("does nothing without a requested language or for non-update commands", () => {
    expect(resolveTranslationSwitch("update", undefined, "en")).toBeUndefined();
    expect(resolveTranslationSwitch("init", "zh-CN", "en")).toBeUndefined();
    expect(resolveTranslationSwitch("chat", "zh-CN", "en")).toBeUndefined();
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
      { from: "en", to: "zh-CN" },
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
      createWikiTranslationMiddleware(backend, "repository", model, {
        from: "en",
        to: "hi",
      }),
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
      createWikiTranslationMiddleware(backend, "repository", model, {
        from: "en",
        to: "zh-CN",
      }),
    );

    expect(edit).not.toHaveBeenCalled();
  });

  test("translates from the local-wiki root", async () => {
    const { backend, rootDir } = await setup("local-wiki");
    await backend.write("/note.md", "# Note\n\nBody.\n");

    const { model } = fakeModel((content) => `[hi] ${content}`);
    await runBeforeAgent(
      createWikiTranslationMiddleware(backend, "local-wiki", model, {
        from: "en",
        to: "hi",
      }),
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
        createWikiTranslationMiddleware(backend, "repository", model, {
          from: "en",
          to: "zh-CN",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
