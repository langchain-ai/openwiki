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

  test("ignores an unrecognized language and falls back to English", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-run-context-"));

    try {
      expect(
        await createRunContext(cwd, "local-wiki", "fake-language"),
      ).toMatchObject({ language: "en" });
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

  test("an unrecognized flag falls back to the persisted language", async () => {
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

      expect(
        await createRunContext(cwd, "local-wiki", "not-a-language"),
      ).toMatchObject({ language: "zh-CN" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
