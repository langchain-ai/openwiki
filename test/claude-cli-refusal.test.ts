import { describe, expect, it } from "vitest";
import {
  buildCliArgs,
  isMissingToolsRefusal,
  type StructuredReply,
} from "../src/agent/claude-cli-model";

describe("buildCliArgs", () => {
  /**
   * The tempting fix, pinned as REJECTED.
   *
   * Moving renderTools out of the user turn and into --append-system-prompt is
   * what the refusal looks like it wants, and it is wrong. Measured 2026-08-15,
   * one prompt, four runs per cell:
   *
   *                    framing in user turn   framing as system prompt
   *   sonnet                    0/3 worked                  3/3 worked
   *   haiku                     4/4 worked                  1/4 worked
   *
   * The models want opposite channels and haiku is what the scheduled runs use,
   * so this would trade one broken model for another. The retry is
   * channel-agnostic and repairs both, so the fix lives there instead.
   */
  it("does not move the framing to a system prompt", () => {
    const args = buildCliArgs("sonnet");

    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--system-prompt");
  });

  // The token savings this provider was built around — and neither is what
  // caused the refusals, so neither should be traded away to fix them.
  it("keeps the flags that make the call cheap", () => {
    const args = buildCliArgs("sonnet");

    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
  });

  it("still enforces the reply schema", () => {
    const args = buildCliArgs("sonnet");
    const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);

    expect(schema.properties.kind.enum).toEqual(["text", "tool_calls"]);
  });

  it("passes the model through", () => {
    expect(buildCliArgs("haiku")[buildCliArgs("haiku").indexOf("--model") + 1]).toBe(
      "haiku",
    );
  });
});

const text = (value: string): StructuredReply => ({ kind: "text", text: value });

/**
 * `claude -p` exposes no native tools, so this provider renders OpenWiki's
 * toolset into the prompt and reads tool calls back out of the structured
 * reply. A model that misreads the empty native roster as a broken session
 * answers with prose about the missing tools — a well-formed kind:"text" reply
 * that the agent loop accepts as a finished turn, so the run reports success
 * having written nothing.
 *
 * The verbatim case below is what the nightly sweep hit on the autojob repo on
 * 2026-08-15; every other repo in that sweep was already current, so nothing
 * else needed a write and nothing else surfaced it.
 */
describe("isMissingToolsRefusal", () => {
  it("catches the refusal measured in the wild", () => {
    expect(
      isMissingToolsRefusal(
        text(
          "I cannot complete this wiki update because the filesystem tools " +
            "(read_file, write_file, edit_file, ls, glob, grep, execute) are not " +
            "available in this CLI execution context. The tools are restricted to " +
            "the interactive harness.\n\nTo update the OpenWiki documentation, you " +
            "need to:\n1. Run this from an interactive Claude Code session",
        ),
      ),
    ).toBe(true);
  });

  it("catches the same inference in other phrasings", () => {
    expect(
      isMissingToolsRefusal(text("I don't have access to any file tools here.")),
    ).toBe(true);
    expect(
      isMissingToolsRefusal(
        text("Unable to proceed — my tool roster is unavailable in this session."),
      ),
    ).toBe(true);
  });

  // A tool_calls reply is the working path and must never be re-prompted, however
  // its prose reads.
  it("never fires on a reply that actually called a tool", () => {
    expect(
      isMissingToolsRefusal({
        kind: "tool_calls",
        text: "I cannot read the filesystem directly, so I will use read_file.",
        tool_calls: [{ name: "read_file", arguments: { path: "README.md" } }],
      }),
    ).toBe(false);
  });

  // BOTH signals are required. Ordinary documentation output discusses tooling
  // constantly, and an agent that re-prompted on that alone would burn a second
  // CLI call on every page it wrote.
  it("does not fire on ordinary docs prose about tools", () => {
    expect(
      isMissingToolsRefusal(
        text(
          "The runner's tools are configured in settings.json. Wrote " +
            "architecture/overview.md and database/schema.md.",
        ),
      ),
    ).toBe(false);
    expect(
      isMissingToolsRefusal(text("I cannot find a changelog entry for v2.")),
    ).toBe(false);
  });

  // The length cap: a page ABOUT this harness legitimately says "the tools are
  // not available inside the session" and also quotes a refusal. Real generated
  // output runs long; a model giving up does not.
  it("does not fire on a long page documenting this very harness", () => {
    const page =
      "# The claude-cli provider\n\n" +
      "The native tool roster is not available inside a `claude -p` session, " +
      "so the harness cannot expose read_file or write_file directly. " +
      "Models sometimes report 'I cannot complete this because the filesystem " +
      "tools are not available'.\n\n".padEnd(4200, "Detail follows. ");

    expect(page.length).toBeGreaterThan(4000);
    expect(isMissingToolsRefusal(text(page))).toBe(false);
  });

  it("does not fire on an empty reply", () => {
    expect(isMissingToolsRefusal(text(""))).toBe(false);
    expect(isMissingToolsRefusal({ kind: "text" })).toBe(false);
  });
});
