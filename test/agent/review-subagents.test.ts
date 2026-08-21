import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  CompositeBackend,
  createDeepAgent,
  FilesystemBackend,
  LocalShellBackend,
} from "deepagents";
import { describe, expect, test } from "vitest";
import {
  REVIEWER_FILESYSTEM_TOOLS,
  resolveRepositoryReviewSubagents,
} from "../../src/agent/review-subagents.ts";

function createReviewBackend(): CompositeBackend {
  return new CompositeBackend(
    new LocalShellBackend({ rootDir: process.cwd(), virtualMode: true }),
    {
      "/skills/": new FilesystemBackend({
        rootDir: process.cwd(),
        virtualMode: true,
      }),
    },
  );
}

function resolveReviewers() {
  return resolveRepositoryReviewSubagents(
    "init",
    "repository",
    createReviewBackend(),
  );
}

describe("repository review subagents", () => {
  test("enables all reviewers only for repository init", () => {
    expect(resolveReviewers().map((subagent) => subagent.name)).toEqual([
      "skeleton-critic",
      "wiki-question-finder",
      "wiki-answer-verifier",
    ]);

    for (const [command, mode] of [
      ["update", "repository"],
      ["chat", "repository"],
      ["init", "local-wiki"],
    ] as const) {
      expect(
        resolveRepositoryReviewSubagents(command, mode, createReviewBackend()),
      ).toEqual([]);
    }
  });

  test("makes reviewers read-only and keeps Claims and Markdown with the parent", () => {
    const reviewers = resolveReviewers();

    expect(reviewers.every((reviewer) => !reviewer.name.includes("_"))).toBe(
      true,
    );
    for (const reviewer of reviewers) {
      expect(reviewer.permissions).toBeUndefined();
      const filesystemMiddleware = reviewer.middleware?.find(
        (middleware) => middleware.name === "FilesystemMiddleware",
      );
      expect(filesystemMiddleware?.tools?.map((tool) => tool.name)).toEqual([
        "ls",
        "read_file",
        "glob",
        "grep",
      ]);
      expect(REVIEWER_FILESYSTEM_TOOLS).not.toContain("write_file");
      expect(REVIEWER_FILESYSTEM_TOOLS).not.toContain("edit_file");
      expect(REVIEWER_FILESYSTEM_TOOLS).not.toContain("execute");
      expect(reviewer.systemPrompt).toContain("read-only");
      expect(reviewer.systemPrompt).toContain("parent agent");
    }

    expect(reviewers[0]?.systemPrompt).toContain("/openwiki/_plan.md");
    expect(reviewers[0]?.systemPrompt).not.toContain("_skeleton.md");
  });

  test("constructs a real DeepAgents graph with hyphenated reviewer names", () => {
    const reviewers = resolveReviewers();

    expect(() =>
      createDeepAgent({
        backend: createReviewBackend(),
        model: new FakeListChatModel({ responses: ["done"] }),
        permissions: [
          { operations: ["write"], paths: ["/skills/**"], mode: "deny" },
        ],
        subagents: reviewers,
      }),
    ).not.toThrow();
  });
});
