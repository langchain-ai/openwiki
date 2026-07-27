import { describe, expect, test } from "vitest";
import { resolveIndexLabels } from "../src/okf/index-labels.ts";

const ENGLISH = { files: "Files", directories: "Directories" };

describe("resolveIndexLabels", () => {
  test("returns English for English, empty, or an unlisted language", () => {
    expect(resolveIndexLabels(undefined)).toEqual(ENGLISH);
    expect(resolveIndexLabels("en")).toEqual(ENGLISH);
    expect(resolveIndexLabels("en-US")).toEqual(ENGLISH);
    expect(resolveIndexLabels("tlh")).toEqual(ENGLISH); // Klingon: not seeded
  });

  test("localizes a listed language", () => {
    expect(resolveIndexLabels("hr")).toEqual({
      files: "Datoteke",
      directories: "Direktoriji",
    });
    expect(resolveIndexLabels("ja")).toEqual({
      files: "ファイル",
      directories: "ディレクトリ",
    });
  });

  test("falls back from a region tag to its primary subtag", () => {
    expect(resolveIndexLabels("hr-HR")).toEqual({
      files: "Datoteke",
      directories: "Direktoriji",
    });
  });

  test("honors region overrides and primary-subtag defaults", () => {
    expect(resolveIndexLabels("zh-CN")).toEqual({
      files: "文件",
      directories: "目录",
    });
    expect(resolveIndexLabels("zh-TW")).toEqual({
      files: "檔案",
      directories: "目錄",
    });
    expect(resolveIndexLabels("pt-BR")).toEqual({
      files: "Arquivos",
      directories: "Diretórios",
    });
    expect(resolveIndexLabels("pt-PT")).toEqual({
      files: "Ficheiros",
      directories: "Diretórios",
    });
  });

  test("degrades to English on a malformed tag", () => {
    expect(resolveIndexLabels("!!")).toEqual(ENGLISH);
  });
});
