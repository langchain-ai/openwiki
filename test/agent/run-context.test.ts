import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  createRunContext,
  writeLastUpdateMetadata,
} from "../../src/agent/utils.ts";

describe("createRunContext output language", () => {
  test("propagates a selected language and defaults to English", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-run-context-"));

    try {
      await expect(
        createRunContext(cwd, "repository", "zh-CN"),
      ).resolves.toMatchObject({
        language: "zh-CN",
      });
      expect(await createRunContext(cwd, "repository")).toMatchObject({
        language: "en",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("canonicalizes the selected language", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-run-context-"));

    try {
      await expect(
        createRunContext(cwd, "local-wiki", "PT-br"),
      ).resolves.toMatchObject({ language: "pt-BR" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("refuses to resolve an unrecognized language to English", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-run-context-"));

    // Entry points reject an unrecognized language before a run starts, so
    // reaching here means a boundary check was skipped. Falling back to English
    // would persist the wrong language and wedge the run at it.
    try {
      await expect(
        createRunContext(cwd, "local-wiki", "fake-language"),
      ).rejects.toThrow("fake-language");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("createRunContext language inheritance", () => {
  test("inherits the persisted wiki language when no flag is given", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-run-context-"));

    try {
      await writeLastUpdateMetadata(
        "update",
        cwd,
        "model-x",
        "local-wiki",
        "complete",
        "zh-CN",
      );

      expect(await createRunContext(cwd, "local-wiki")).toMatchObject({
        language: "zh-CN",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("an explicit flag overrides the persisted language", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-run-context-"));

    try {
      await writeLastUpdateMetadata(
        "update",
        cwd,
        "model-x",
        "local-wiki",
        "complete",
        "zh-CN",
      );

      expect(await createRunContext(cwd, "local-wiki", "hi")).toMatchObject({
        language: "hi",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("refuses an unrecognized flag rather than inheriting silently", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-run-context-"));

    try {
      await writeLastUpdateMetadata(
        "update",
        cwd,
        "model-x",
        "local-wiki",
        "complete",
        "zh-CN",
      );

      await expect(
        createRunContext(cwd, "local-wiki", "not-a-language"),
      ).rejects.toThrow("not-a-language");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
