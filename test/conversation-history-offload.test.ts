import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import {
  CONVERSATION_HISTORY_MOUNT,
  createAgentBackend,
} from "../src/agent/index.ts";

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
});
