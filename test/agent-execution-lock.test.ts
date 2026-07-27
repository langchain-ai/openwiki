import { expect, test } from "vitest";
import { getOpenWikiExecutionLockScope } from "../src/agent/runtime-lock.ts";

test("builds a repository lock scope before the native agent starts", () => {
  expect(
    getOpenWikiExecutionLockScope("init", "/workspace/repository", {
      outputMode: "repository",
    }),
  ).toEqual({
    command: "init",
    cwd: "/workspace/repository",
    outputMode: "repository",
  });
});

test("uses the shared personal scope when no repository output mode is selected", () => {
  expect(getOpenWikiExecutionLockScope("chat", "/ignored", {})).toMatchObject({
    command: "chat",
    outputMode: "local-wiki",
  });
});
