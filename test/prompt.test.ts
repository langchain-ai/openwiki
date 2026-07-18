import { describe, expect, test } from "vitest";
import { createSystemPrompt } from "../src/agent/prompt.ts";

/**
 * Guards against the 0.2 regression where the shared "Canonical wiki location"
 * and "Wiki-first question answering" blocks hardcoded ~/.openwiki/wiki and
 * leaked into repository (code) mode. In code mode the filesystem virtual root
 * maps to the repo, so instructing the model to use ~/.openwiki/wiki made it
 * type non-absolute host paths into filesystem tools and crash the run.
 */
describe("createSystemPrompt filesystem path guidance", () => {
  const commands = ["init", "update", "chat"] as const;

  describe("repository mode", () => {
    for (const command of commands) {
      test(`${command}: does not point the wiki at ~/.openwiki/wiki`, () => {
        const prompt = createSystemPrompt(command, "repository");

        // The canonical location must be the repo-local /openwiki, never the
        // personal-brain home dir.
        expect(prompt).not.toMatch(/lives in ~\/\.openwiki\/wiki/);
        expect(prompt).not.toMatch(/inspect ~\/\.openwiki\/wiki first/);
        expect(prompt).toContain("/openwiki");
      });
    }
  });

  describe("local-wiki mode", () => {
    for (const command of commands) {
      test(`${command}: roots the wiki at ~/.openwiki/wiki via virtual /`, () => {
        const prompt = createSystemPrompt(command, "local-wiki");

        expect(prompt).toContain("~/.openwiki/wiki");
        expect(prompt).toContain("/quickstart.md");
      });
    }
  });

  test("both modes forbid typing host/tilde paths into filesystem tools", () => {
    for (const outputMode of ["repository", "local-wiki"] as const) {
      const prompt = createSystemPrompt("update", outputMode);
      expect(prompt).toMatch(
        /Never type ~, ~\/\.openwiki\/wiki, or host paths/,
      );
    }
  });
});
