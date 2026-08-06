import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { createSummarizationMiddleware } from "deepagents";
import { describe, expect, test, vi } from "vitest";
import { OpenWikiLocalShellBackend } from "../../src/agent/docs-only-backend.ts";
import {
  AGENT_FILESYSTEM_PERMISSIONS,
  CONVERSATION_HISTORY_MOUNT,
  createAgentBackend,
} from "../../src/agent/index.ts";

async function createBackendFixture(options: { docsOnly: boolean }) {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-repo-"));
  const historyDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-history-"));
  const skillsDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-skills-"));
  const wikiBackend = new OpenWikiLocalShellBackend({
    docsOnly: options.docsOnly,
    rootDir: repoDir,
    virtualMode: true,
  });
  const backend = createAgentBackend(wikiBackend, { historyDir, skillsDir });

  return { backend, historyDir, repoDir };
}

describe("createAgentBackend conversation history offload", () => {
  test("returns a tool error when a glob exceeds the call stack", async () => {
    const { backend } = await createBackendFixture({ docsOnly: true });
    vi.spyOn(OpenWikiLocalShellBackend.prototype, "glob").mockRejectedValueOnce(
      new RangeError("Maximum call stack size exceeded"),
    );

    await expect(backend.glob("**/*", "/")).resolves.toEqual({
      error:
        "Glob search was too broad. Retry with a narrower path or pattern.",
    });
  });

  test("permits the summarization history offload on docs-only runs", async () => {
    const { backend, historyDir, repoDir } = await createBackendFixture({
      docsOnly: true,
    });
    const offloadPath = `${CONVERSATION_HISTORY_MOUNT}session_19c647c9.md`;

    const write = await backend.write(offloadPath, "## Summarized at t0\n");
    expect(write.error).toBeUndefined();

    // The offload lands outside the documented repository.
    await expect(
      readFile(path.join(historyDir, "session_19c647c9.md"), "utf8"),
    ).resolves.toBe("## Summarized at t0\n");
    await expect(
      stat(path.join(repoDir, "conversation_history")),
    ).rejects.toThrow();

    // Follow-up offloads append via edit, and the agent can read the
    // offloaded history back through the same virtual path.
    const edit = await backend.edit(
      offloadPath,
      "## Summarized at t0\n",
      "## Summarized at t0\n## Summarized at t1\n",
    );
    expect(edit.error).toBeUndefined();
    const read = await backend.read(offloadPath);
    expect(read.error).toBeUndefined();
    expect(read.content).toContain("## Summarized at t1");
  });

  test("keeps the docs-only guard intact for non-offload writes", async () => {
    const { backend, repoDir } = await createBackendFixture({ docsOnly: true });

    const refused = await backend.write("/AGENTS.md", "bad");
    expect(refused.error).toContain("Refused path: /AGENTS.md");
    await expect(stat(path.join(repoDir, "AGENTS.md"))).rejects.toThrow();

    const allowed = await backend.write("/openwiki/architecture.md", "ok");
    expect(allowed.error).toBeUndefined();
    await expect(
      readFile(path.join(repoDir, "openwiki/architecture.md"), "utf8"),
    ).resolves.toBe("ok");
  });

  test("keeps chat-mode history offloads out of the workspace", async () => {
    const { backend, historyDir, repoDir } = await createBackendFixture({
      docsOnly: false,
    });
    const offloadPath = `${CONVERSATION_HISTORY_MOUNT}session_chat.md`;

    const write = await backend.write(offloadPath, "history");
    expect(write.error).toBeUndefined();
    await expect(
      readFile(path.join(historyDir, "session_chat.md"), "utf8"),
    ).resolves.toBe("history");
    await expect(
      stat(path.join(repoDir, "conversation_history")),
    ).rejects.toThrow();
  });

  test("denies agent-layer tool writes to the history mount", () => {
    // The summarization middleware writes through the backend directly and
    // is unaffected by agent-layer permissions (covered by the offload tests
    // above). The model's filesystem tools must not be able to write into
    // the mount, or a prompt injection in an analyzed repository could
    // persist attacker content that later summarization turns read back.
    const denied = AGENT_FILESYSTEM_PERMISSIONS.filter(
      (rule) =>
        rule.mode === "deny" &&
        rule.operations.includes("write") &&
        rule.paths.includes(`${CONVERSATION_HISTORY_MOUNT}**`),
    );
    expect(denied).toHaveLength(1);
    // The skills mount stays read-only too.
    expect(
      AGENT_FILESYSTEM_PERMISSIONS.some(
        (rule) => rule.mode === "deny" && rule.paths.includes("/skills/**"),
      ),
    ).toBe(true);
  });

  test("mount prefix matches deepagents' historyPathPrefix default", async () => {
    // CONVERSATION_HISTORY_MOUNT is kept in sync with deepagents'
    // summarization middleware by hand because createDeepAgent exposes no
    // override. Drive the installed middleware without a historyPathPrefix
    // and capture where it actually offloads, so a dependency bump that
    // moves the default fails here instead of silently reintroducing #496.
    const writes: string[] = [];
    const recordingBackend = {
      write: (filePath: string) => {
        writes.push(filePath);
        return Promise.resolve({ path: filePath });
      },
    };
    const middleware = createSummarizationMiddleware({
      model: {
        invoke: () => Promise.resolve(new AIMessage("summary")),
      } as never,
      backend: recordingBackend as never,
      trigger: { type: "messages", value: 1 },
      keep: { type: "messages", value: 1 },
    });

    const messages = [
      new HumanMessage("first"),
      new AIMessage("second"),
      new HumanMessage("third"),
    ];
    await (
      middleware as unknown as {
        wrapModelCall: (
          request: unknown,
          handler: (request: unknown) => Promise<unknown>,
        ) => Promise<unknown>;
      }
    ).wrapModelCall(
      { messages, state: {}, systemMessage: undefined, tools: [] },
      () => Promise.resolve({ result: [] }),
    );

    expect(writes).toHaveLength(1);
    expect(path.posix.dirname(writes[0]) + "/").toBe(
      CONVERSATION_HISTORY_MOUNT,
    );
  });
});
