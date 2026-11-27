import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";

// Exercise the real history-offload mounts against isolated state so the
// per-root directories land inside a throwaway OPENWIKI_CONFIG_DIR instead of
// the user's persistent configuration.
const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const directory = mkdtempSync(
    path.join(tmpdir(), "openwiki-history-isolation-"),
  );
  vi.stubEnv("OPENWIKI_CONFIG_DIR", directory);
  return directory;
});

import { OpenWikiLocalShellBackend } from "../../src/agent/docs-only-backend.ts";
import {
  CONVERSATION_HISTORY_MOUNT,
  createAgentBackend,
} from "../../src/agent/agent-backend.ts";
import { getConversationHistoryDirForRoot } from "../../src/config/openwiki-home.ts";

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("conversation history isolation", () => {
  test("scopes the history mount to one directory per repository root", async () => {
    const trustedRoot = await mkdtemp(path.join(tmpdir(), "openwiki-trusted-"));
    const untrustedRoot = await mkdtemp(
      path.join(tmpdir(), "openwiki-untrusted-"),
    );
    try {
      const trustedBackend = createAgentBackend(
        new OpenWikiLocalShellBackend({
          docsOnly: false,
          rootDir: trustedRoot,
          virtualMode: true,
        }),
      );
      const untrustedBackend = createAgentBackend(
        new OpenWikiLocalShellBackend({
          docsOnly: false,
          rootDir: untrustedRoot,
          virtualMode: true,
        }),
      );

      // A personal-mode run offloads mail and chat content from the trusted root.
      const offloadPath = `${CONVERSATION_HISTORY_MOUNT}session_personal.md`;
      const write = await trustedBackend.write(offloadPath, "mail summary");
      expect(write.error).toBeUndefined();

      // An agent working on the other, untrusted repository must neither read
      // nor discover that offloaded history through its own mount.
      const read = await untrustedBackend.read(offloadPath);
      expect(read.error).toBeDefined();
      const glob = await untrustedBackend.glob(
        "session_*.md",
        CONVERSATION_HISTORY_MOUNT,
      );
      expect(glob.files).toEqual([]);

      // The trusted root's own agent can still read its history back.
      const reread = await trustedBackend.read(offloadPath);
      expect(reread.error).toBeUndefined();
      expect(reread.content).toContain("mail summary");

      // The offload landed in the trusted root's own history directory.
      expect(getConversationHistoryDirForRoot(trustedRoot)).not.toBe(
        getConversationHistoryDirForRoot(untrustedRoot),
      );
      await expect(
        readFile(
          path.join(
            getConversationHistoryDirForRoot(trustedRoot),
            "session_personal.md",
          ),
          "utf8",
        ),
      ).resolves.toBe("mail summary");
    } finally {
      await rm(trustedRoot, { recursive: true, force: true });
      await rm(untrustedRoot, { recursive: true, force: true });
    }
  });
});
