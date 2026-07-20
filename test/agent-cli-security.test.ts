import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildAgentCliChildEnv,
  shouldPassEnvKey,
} from "../src/agent/engines/child-env.ts";
import { runAgentCli } from "../src/agent/engines/runner.ts";
import type {
  AgentCliAdapter,
  EngineRunSpec,
} from "../src/agent/engines/types.ts";
import {
  findDisallowedWrites,
  isAllowedDocsOnlyWritePath,
} from "../src/agent/engines/write-boundary.ts";
import type { AgentCliProviderConfig } from "../src/constants.ts";

const originalTimeout = process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS;
const originalAnthropic = process.env.ANTHROPIC_API_KEY;
const originalOpenWikiProvider = process.env.OPENWIKI_PROVIDER;

afterEach(() => {
  if (originalTimeout === undefined) {
    delete process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS;
  } else {
    process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS = originalTimeout;
  }

  if (originalAnthropic === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropic;
  }

  if (originalOpenWikiProvider === undefined) {
    delete process.env.OPENWIKI_PROVIDER;
  } else {
    process.env.OPENWIKI_PROVIDER = originalOpenWikiProvider;
  }
});

describe("buildAgentCliChildEnv", () => {
  test("passes PATH and HOME but drops managed secrets", () => {
    const childEnv = buildAgentCliChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      ANTHROPIC_API_KEY: "sk-secret",
      OPENWIKI_PROVIDER: "anthropic",
      OPENWIKI_NOTION_TOKEN: "secret-token",
      LANGSMITH_API_KEY: "lsv2_secret",
      LANGCHAIN_TRACING_V2: "true",
      TERM: "xterm-256color",
      SOME_RANDOM_APP_VAR: "should-not-pass",
    });

    expect(childEnv.PATH).toBe("/usr/bin");
    expect(childEnv.HOME).toBe("/home/user");
    expect(childEnv.TERM).toBe("xterm-256color");
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(childEnv.OPENWIKI_PROVIDER).toBeUndefined();
    expect(childEnv.OPENWIKI_NOTION_TOKEN).toBeUndefined();
    expect(childEnv.LANGSMITH_API_KEY).toBeUndefined();
    expect(childEnv.LANGCHAIN_TRACING_V2).toBeUndefined();
    expect(childEnv.SOME_RANDOM_APP_VAR).toBeUndefined();
  });

  test("shouldPassEnvKey blocks secret-like names", () => {
    expect(shouldPassEnvKey("PATH")).toBe(true);
    expect(shouldPassEnvKey("HOME")).toBe(true);
    expect(shouldPassEnvKey("MY_API_KEY")).toBe(false);
    expect(shouldPassEnvKey("REFRESH_TOKEN")).toBe(false);
    expect(shouldPassEnvKey("OPENWIKI_DEBUG")).toBe(false);
  });
});

describe("write-boundary helpers", () => {
  test("allows openwiki paths and root instruction files only", () => {
    expect(isAllowedDocsOnlyWritePath("openwiki/quickstart.md")).toBe(true);
    expect(isAllowedDocsOnlyWritePath("openwiki/.last-update.json")).toBe(true);
    expect(isAllowedDocsOnlyWritePath("AGENTS.md")).toBe(true);
    expect(isAllowedDocsOnlyWritePath("CLAUDE.md")).toBe(true);
    expect(isAllowedDocsOnlyWritePath("src/index.ts")).toBe(false);
    expect(isAllowedDocsOnlyWritePath("package.json")).toBe(false);
  });

  test("allows the git index, which read-only git commands refresh", () => {
    expect(isAllowedDocsOnlyWritePath(".git/index")).toBe(true);
  });

  test("still rejects git hook and config writes", () => {
    expect(isAllowedDocsOnlyWritePath(".git/hooks/pre-commit")).toBe(false);
    expect(isAllowedDocsOnlyWritePath(".git/config")).toBe(false);
  });

  test("findDisallowedWrites reports files outside the boundary", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-wb-"));
    const sinceMs = Date.now() - 1000;

    await mkdir(path.join(dir, "openwiki"), { recursive: true });
    await writeFile(path.join(dir, "openwiki", "ok.md"), "docs", "utf8");
    await writeFile(path.join(dir, "evil.ts"), "pwned", "utf8");

    const disallowed = await findDisallowedWrites(dir, sinceMs, "docs-only");

    expect(disallowed).toContain("evil.ts");
    expect(disallowed).not.toContain("openwiki/ok.md");
  });

  test("findDisallowedWrites detects writes under .git (hooks bypass)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-wb-"));
    const sinceMs = Date.now() - 1000;

    await mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
    await mkdir(path.join(dir, "openwiki"), { recursive: true });
    await writeFile(path.join(dir, "openwiki", "ok.md"), "docs", "utf8");
    await writeFile(
      path.join(dir, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\necho pwned\n",
      "utf8",
    );

    const disallowed = await findDisallowedWrites(dir, sinceMs, "docs-only");

    expect(disallowed).toContain(".git/hooks/pre-commit");
    expect(disallowed).not.toContain("openwiki/ok.md");
  });
});

describe("runAgentCli security controls", () => {
  test("does not forward secrets into the child environment", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-agent-cli-"));
    const script = path.join(dir, "dump-env.mjs");
    const outFile = path.join(dir, "env-dump.json");

    await writeFile(
      script,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(process.env));
console.log(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "s1" }));
`,
      { mode: 0o755 },
    );

    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    process.env.OPENWIKI_PROVIDER = "anthropic";
    process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS = "30";

    const adapter: AgentCliAdapter = {
      id: "dump-env",
      detectInstall() {
        return Promise.resolve({ found: true, version: "0" });
      },
      buildArgs() {
        return [];
      },
      createParser() {
        return {
          parse(line: unknown) {
            if (
              typeof line === "object" &&
              line !== null &&
              (line as { type?: string }).type === "end"
            ) {
              return [
                { type: "session", sessionId: "s1" },
                { type: "result", ok: true },
              ];
            }

            return [];
          },
          flush: () => [],
        };
      },
    };

    const providerConfig: AgentCliProviderConfig = {
      kind: "agent-cli",
      binaryEnvKey: "OPENWIKI_TEST_DUMP_ENV_BINARY",
      defaultBinary: script,
      installHint: "n/a",
      label: "Dump Env",
      modelOptions: [],
    };

    const spec: EngineRunSpec = {
      command: "chat",
      cwd: dir,
      modelId: "x",
      prompt: "hi",
      writeBoundary: "none",
    };

    await runAgentCli(adapter, providerConfig, spec, {});

    const dumped = JSON.parse(await readFile(outFile, "utf8")) as Record<
      string,
      string
    >;

    expect(dumped.ANTHROPIC_API_KEY).toBeUndefined();
    expect(dumped.OPENWIKI_PROVIDER).toBeUndefined();
    expect(dumped.HOME ?? dumped.USERPROFILE).toBeTruthy();
  });

  test("fails docs-only runs that write outside openwiki/", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-agent-cli-"));
    // Keep the fake binary outside cwd so the boundary scan does not see it.
    const binDir = await mkdtemp(path.join(tmpdir(), "openwiki-agent-bin-"));
    const script = path.join(binDir, "write-evil.mjs");

    await writeFile(
      script,
      `#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
mkdirSync(path.join(process.cwd(), "openwiki"), { recursive: true });
writeFileSync(path.join(process.cwd(), "openwiki", "ok.md"), "docs");
writeFileSync(path.join(process.cwd(), "evil.ts"), "pwned");
console.log(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "s2" }));
`,
      { mode: 0o755 },
    );
    await chmod(script, 0o755);

    process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS = "30";

    const adapter: AgentCliAdapter = {
      id: "write-evil",
      detectInstall() {
        return Promise.resolve({ found: true, version: "0" });
      },
      buildArgs() {
        return [];
      },
      createParser() {
        return {
          parse(line: unknown) {
            if (
              typeof line === "object" &&
              line !== null &&
              (line as { type?: string }).type === "end"
            ) {
              return [
                { type: "session", sessionId: "s2" },
                { type: "result", ok: true },
              ];
            }

            return [];
          },
          flush: () => [],
        };
      },
    };

    const providerConfig: AgentCliProviderConfig = {
      kind: "agent-cli",
      binaryEnvKey: "OPENWIKI_TEST_WRITE_EVIL_BINARY",
      defaultBinary: script,
      installHint: "n/a",
      label: "Write Evil",
      modelOptions: [],
    };

    await expect(
      runAgentCli(
        adapter,
        providerConfig,
        {
          command: "init",
          cwd: dir,
          modelId: "x",
          prompt: "init",
          writeBoundary: "docs-only",
        },
        {},
      ),
    ).rejects.toThrow(/docs-only write boundary/);
  });

  test("fails docs-only runs that write a git hook under .git/", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-agent-cli-"));
    const binDir = await mkdtemp(path.join(tmpdir(), "openwiki-agent-bin-"));
    const script = path.join(binDir, "write-git-hook.mjs");

    await writeFile(
      script,
      `#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
mkdirSync(path.join(process.cwd(), "openwiki"), { recursive: true });
mkdirSync(path.join(process.cwd(), ".git", "hooks"), { recursive: true });
writeFileSync(path.join(process.cwd(), "openwiki", "ok.md"), "docs");
writeFileSync(
  path.join(process.cwd(), ".git", "hooks", "pre-commit"),
  "#!/bin/sh\\necho pwned\\n",
);
console.log(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "s-git" }));
`,
      { mode: 0o755 },
    );

    process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS = "30";

    const adapter: AgentCliAdapter = {
      id: "write-git-hook",
      detectInstall() {
        return Promise.resolve({ found: true, version: "0" });
      },
      buildArgs() {
        return [];
      },
      createParser() {
        return {
          parse(line: unknown) {
            if (
              typeof line === "object" &&
              line !== null &&
              (line as { type?: string }).type === "end"
            ) {
              return [
                { type: "session", sessionId: "s-git" },
                { type: "result", ok: true },
              ];
            }

            return [];
          },
          flush: () => [],
        };
      },
    };

    const providerConfig: AgentCliProviderConfig = {
      kind: "agent-cli",
      binaryEnvKey: "OPENWIKI_TEST_WRITE_GIT_HOOK_BINARY",
      defaultBinary: script,
      installHint: "n/a",
      label: "Write Git Hook",
      modelOptions: [],
    };

    await expect(
      runAgentCli(
        adapter,
        providerConfig,
        {
          command: "init",
          cwd: dir,
          modelId: "x",
          prompt: "init",
          writeBoundary: "docs-only",
        },
        {},
      ),
    ).rejects.toThrow(/docs-only write boundary/);
  });

  test("allows docs-only runs that only write under openwiki/", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-agent-cli-"));
    const binDir = await mkdtemp(path.join(tmpdir(), "openwiki-agent-bin-"));
    const script = path.join(binDir, "write-ok.mjs");

    await writeFile(
      script,
      `#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
mkdirSync(path.join(process.cwd(), "openwiki"), { recursive: true });
writeFileSync(path.join(process.cwd(), "openwiki", "quickstart.md"), "docs");
console.log(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "s3" }));
`,
      { mode: 0o755 },
    );

    process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS = "30";

    const adapter: AgentCliAdapter = {
      id: "write-ok",
      detectInstall() {
        return Promise.resolve({ found: true, version: "0" });
      },
      buildArgs() {
        return [];
      },
      createParser() {
        return {
          parse(line: unknown) {
            if (
              typeof line === "object" &&
              line !== null &&
              (line as { type?: string }).type === "end"
            ) {
              return [
                { type: "session", sessionId: "s3" },
                { type: "result", ok: true },
              ];
            }

            return [];
          },
          flush: () => [],
        };
      },
    };

    const providerConfig: AgentCliProviderConfig = {
      kind: "agent-cli",
      binaryEnvKey: "OPENWIKI_TEST_WRITE_OK_BINARY",
      defaultBinary: script,
      installHint: "n/a",
      label: "Write Ok",
      modelOptions: [],
    };

    const outcome = await runAgentCli(
      adapter,
      providerConfig,
      {
        command: "init",
        cwd: dir,
        modelId: "x",
        prompt: "init",
        writeBoundary: "docs-only",
      },
      {},
    );

    expect(outcome.sessionId).toBe("s3");
  });
});
