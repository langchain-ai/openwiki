import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "vitest";
import { z } from "zod";
import { ensureCodeModeRepoSetup } from "../../src/ingestion/code-mode.ts";
import { HostIntegrationInstaller } from "../../src/integrations/install/installer.ts";
import { HOST_TARGETS } from "../../src/integrations/install/registry.ts";

/**
 * Built CLI used by the installed MCP command, exercising the shipped process boundary.
 */
const CLI = fileURLToPath(new URL("../../dist/cli/cli.js", import.meta.url));

/**
 * Repository-relative wiki page followed throughout the representative task.
 */
const PAGE = "concepts/jobs.md";

/**
 * Discovery deliberately absent from the baseline wiki's retry explanation.
 */
const FINDING =
  "The attempt limit includes the initial call: a budget of three permits at most two retries.";

/**
 * Complete task-specific read projection used to verify the three memory layers.
 */
const ReadMemory = z.object({
  longTerm: z.object({
    sections: z.array(z.object({ id: z.string(), content: z.string() })),
    claims: z.array(z.object({ id: z.string(), statement: z.string() })),
    bindings: z.array(
      z.object({
        id: z.string(),
        sectionId: z.string(),
        text: z.string(),
        claimIds: z.array(z.string()),
      }),
    ),
  }),
  shortTerm: z.object({
    changes: z.array(
      z.strictObject({
        resource: z.string(),
        inCheckout: z.boolean(),
        affectedClaimIds: z.array(z.string()),
      }),
    ),
    reflections: z.array(
      z.object({
        id: z.string(),
        finding: z.string(),
        relatedClaimIds: z.array(z.string()),
      }),
    ),
  }),
  working: z.object({
    changes: z.array(
      z.strictObject({
        resource: z.string(),
        affectedClaimIds: z.array(z.string()),
      }),
    ),
    reflections: z.array(
      z.object({
        id: z.string(),
        finding: z.string(),
        relatedClaimIds: z.array(z.string()),
      }),
    ),
  }),
});

/**
 * Calls one real MCP tool and retains its complete failure payload for diagnostics.
 *
 * @param client - Connected installed integration.
 * @param name - Advertised OpenWiki tool name.
 * @param args - Exact model-facing arguments.
 * @returns Successful structured tool output.
 */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError)
    throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  return result.structuredContent;
}

/**
 * Renders the small retry implementation used as task evidence.
 *
 * @param attempts - Default total attempt budget.
 * @returns Complete source for a bounded retry loop.
 */
function retrySource(attempts: number): string {
  return `export const DEFAULT_ATTEMPTS = ${attempts};\nexport function run(task: () => boolean): boolean {\n  for (let attempt = 0; attempt < DEFAULT_ATTEMPTS; attempt++) {\n    if (task()) return true;\n  }\n  return false;\n}\n`;
}

test("an installed MCP integration carries a coding discovery from branch context through sharing and consolidation", async () => {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "openwiki-memory-workflow-")),
  );
  const root = path.join(directory, "repository");
  const clients: Client[] = [];
  const diagnostics: string[] = [];
  await mkdir(root);

  /**
   * Executes isolated Git operations without user signing or identity requirements.
   *
   * @param args - Literal Git arguments.
   * @returns Trimmed command output.
   */
  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=OpenWiki Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: "pipe" },
    ).trim();

  /**
   * Writes a repository fixture file and its containing directory.
   *
   * @param file - Repository-relative destination.
   * @param content - Complete authored contents.
   */
  const write = async (file: string, content: string): Promise<void> => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };

  /**
   * Commits the fixture's current state to model a task or main change.
   *
   * @param message - Purpose of the test commit.
   */
  const commit = (message: string): void => {
    git("add", ".");
    git("commit", "--quiet", "-m", message);
  };

  try {
    git("init", "--quiet", "-b", "main");
    await write("README.md", "Acme runs background jobs.\n");
    await write("src/retry.ts", retrySource(3));
    await write(
      "src/cancel.ts",
      "export function canStartAttempt(cancelled: boolean): boolean {\n  return !cancelled;\n}\n",
    );
    await ensureCodeModeRepoSetup(root, { createWorkflow: true, env: {} });
    await new HostIntegrationInstaller().install(HOST_TARGETS.claude, {
      scope: "project",
      root,
      mcpServerCommand: {
        command: process.execPath,
        args: [CLI, "mcp", "--host", "claude"],
      },
    });
    const config = z
      .object({
        mcpServers: z.object({
          openwiki: z.object({
            command: z.string(),
            args: z.array(z.string()),
          }),
        }),
      })
      .parse(
        JSON.parse(
          await readFile(path.join(root, ".mcp.json"), "utf8"),
        ) as unknown,
      );
    const skill = await readFile(
      path.join(root, ".claude/skills/openwiki/SKILL.md"),
      "utf8",
    );
    for (const tool of ["orient", "outline", "read", "reflect"])
      expect(skill).toContain(`openwiki_${tool}`);
    commit("source and integration baseline");

    /**
     * Starts a fresh agent connection using exactly the command written by installation.
     *
     * @returns Connected MCP client with stderr retained for failure output.
     */
    const connect = async (): Promise<Client> => {
      const client = new Client({ name: "memory-workflow", version: "1.0.0" });
      clients.push(client);
      const transport = new StdioClientTransport({
        ...config.mcpServers.openwiki,
        cwd: root,
        stderr: "pipe",
        env: {
          ...getDefaultEnvironment(),
          OPENWIKI_CONFIG_DIR: path.join(directory, "runtime"),
          OPENWIKI_TELEMETRY_DISABLED: "1",
        },
      });
      transport.stderr?.on("data", (chunk: Buffer) =>
        diagnostics.push(chunk.toString("utf8")),
      );
      await client.connect(transport);
      return client;
    };
    const first = await connect();
    const names = (await first.listTools()).tools.map(({ name }) => name);
    for (const file of ["AGENTS.md", "CLAUDE.md"]) {
      const guidance = await readFile(path.join(root, file), "utf8");
      for (const name of guidance.matchAll(/\bopenwiki_\w+\b/gu))
        expect(names).toContain(name[0]);
      expect(guidance).toContain("openwiki/quickstart.md");
    }
    const { runId } = z
      .object({ runId: z.string() })
      .parse(await call(first, "openwiki_begin", { root, mode: "init" }));
    await call(first, "openwiki_submit_plan", {
      runId,
      pages: [
        {
          path: `/openwiki/${PAGE}`,
          title: "Jobs",
          purpose: "Explain retries and cancellation.",
        },
        {
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Introduce the repository.",
        },
      ],
    });
    const baseline = "Jobs receive at most three attempts.";
    for (const quickstart of [false, true]) {
      const { job } = z
        .object({ job: z.object({ id: z.string(), path: z.string() }) })
        .parse(await call(first, "openwiki_next_page", { runId }));
      const text = quickstart ? "Acme runs background jobs." : baseline;
      const page = quickstart ? "quickstart.md" : PAGE;
      const location = quickstart
        ? "quickstart.md#Quickstart"
        : `${PAGE}#Jobs#Retries`;
      await write(
        `openwiki/${page}`,
        quickstart
          ? `---\ntype: guide\ntitle: Quickstart\ndescription: Repository purpose and navigation.\n---\n# Quickstart\n\n${text}\n`
          : `---\ntype: concept\ntitle: Jobs\ndescription: Attempt limits and cancellation.\n---\n# Jobs\n\n## Retries\n\n${text}\n\n## Cancellation\n\nCancellation prevents starting another attempt.\n`,
      );
      await call(first, "openwiki_submit_page", {
        runId,
        jobId: job.id,
        claims: [
          {
            statement: text,
            evidence: [
              {
                resource: quickstart
                  ? "repo://README.md"
                  : "repo://src/retry.ts",
              },
            ],
          },
          ...(!quickstart
            ? [
                {
                  statement: "Cancellation prevents starting another attempt.",
                  evidence: [{ resource: "repo://src/cancel.ts" }],
                },
              ]
            : []),
        ],
        sections: quickstart
          ? [{ location, description: "Repository purpose." }]
          : [
              { location: `${PAGE}#Jobs`, description: "Job lifecycle." },
              { location, description: "Attempt limits." },
              {
                location: `${PAGE}#Jobs#Cancellation`,
                description: "Stopping new attempts.",
              },
            ],
        bindings: [
          { section: location, text, claims: [text] },
          ...(!quickstart
            ? [
                {
                  section: `${PAGE}#Jobs#Cancellation`,
                  text: "Cancellation prevents starting another attempt.",
                  claims: ["Cancellation prevents starting another attempt."],
                },
              ]
            : []),
        ],
      });
    }
    await call(first, "openwiki_finish", { runId });
    commit("verified wiki baseline");

    git("checkout", "--quiet", "-b", "task");
    git("checkout", "--quiet", "main");
    await write("src/retry.ts", retrySource(5));
    commit("raise main attempt budget");
    git("checkout", "--quiet", "task");
    const orient = z
      .object({
        longTerm: z.object({
          overview: z.string(),
          pages: z.array(z.object({ page: z.string(), title: z.string() })),
        }),
        shortTerm: z.object({
          changes: z.array(z.object({ affectedPages: z.array(z.string()) })),
        }),
      })
      .parse(await call(first, "openwiki_orient", { root }));
    expect(orient.longTerm.overview).toBe("Acme runs background jobs.");
    expect(orient.longTerm.pages.find(({ page }) => page === PAGE)?.title).toBe(
      "Jobs",
    );
    expect(orient.shortTerm.changes[0].affectedPages).toEqual([PAGE]);
    const outline = z
      .object({
        longTerm: z.object({
          sections: z.array(z.object({ id: z.string(), title: z.string() })),
        }),
        shortTerm: z.object({
          changes: z.array(
            z.object({ affectedSectionIds: z.array(z.string()) }),
          ),
        }),
      })
      .parse(await call(first, "openwiki_outline", { root, page: PAGE }));
    const section = outline.longTerm.sections.find(
      ({ title }) => title === "Retries",
    )!;
    expect(outline.shortTerm.changes[0].affectedSectionIds).toEqual([
      section.id,
    ]);

    /**
     * Reads the known section directly, without requiring orientation in a new agent session.
     *
     * @param client - Agent connection doing the task.
     * @returns Validated long-term knowledge and current source/reflection context.
     */
    const read = async (client: Client) =>
      ReadMemory.parse(
        await call(client, "openwiki_read", {
          root,
          page: PAGE,
          sections: [section.id],
        }),
      );
    const behind = await read(first);
    const claim = behind.longTerm.claims[0];
    expect(behind.longTerm.sections).toHaveLength(1);
    expect(behind.longTerm.claims).toHaveLength(1);
    expect(claim.statement).toBe(baseline);
    expect(behind.shortTerm.changes[0].inCheckout).toBe(false);
    expect(behind.shortTerm.changes[0].affectedClaimIds).toEqual([claim.id]);
    expect(behind.shortTerm.changes[0].resource).toBe("repo://src/retry.ts");
    expect(behind.working.changes).toEqual([]);
    git("merge", "--quiet", "--ff-only", "main");
    expect((await read(first)).shortTerm.changes[0].inCheckout).toBe(true);
    await write("src/retry.ts", retrySource(7));
    const local = await read(first);
    expect(local.shortTerm.changes[0].inCheckout).toBe(true);
    expect(local.working.changes).toEqual([
      { resource: "repo://src/retry.ts", affectedClaimIds: [claim.id] },
    ]);

    /**
     * Records a task discovery through the installed MCP tool.
     *
     * @param finding - Authored finding awaiting verification.
     * @param resource - Source evidence that the next agent can inspect.
     * @returns Captured file identity.
     */
    const reflect = async (finding: string, resource = "repo://src/retry.ts") =>
      z.object({ id: z.string(), path: z.string() }).parse(
        await call(first, "openwiki_reflect", {
          root,
          finding,
          evidence: [{ resource }],
        }),
      );
    const useful = await reflect(FINDING);
    const duplicate = await reflect(FINDING);
    const unsupported = await reflect(
      "The retry loop allows unlimited attempts.",
    );
    const captured = [useful, duplicate, unsupported];
    const second = await connect();
    expect(
      (await read(second)).working.reflections.map(({ id }) => id).sort(),
    ).toEqual(captured.map(({ id }) => id).sort());
    commit("task change and discoveries");
    git("checkout", "--quiet", "main");
    git("merge", "--quiet", "--ff-only", "task");
    const shared = await read(second);
    expect(shared.shortTerm.reflections.map(({ id }) => id).sort()).toEqual(
      captured.map(({ id }) => id).sort(),
    );
    expect(shared.working.reflections).toEqual([]);
    expect(shared.longTerm.claims[0].statement).toBe(baseline);

    const update = z
      .object({
        runId: z.string(),
        reflections: z.array(z.object({ id: z.string() })),
      })
      .parse(await call(second, "openwiki_begin", { root, mode: "update" }));
    expect(update.reflections.map(({ id }) => id).sort()).toEqual(
      captured.map(({ id }) => id).sort(),
    );
    await call(second, "openwiki_submit_plan", {
      runId: update.runId,
      pages: [
        {
          path: `/openwiki/${PAGE}`,
          title: "Jobs",
          purpose: "Reconcile attempt counting.",
          reflectionIds: [useful.id, duplicate.id],
        },
      ],
      discardedReflectionIds: [unsupported.id],
    });
    const arrival = await reflect(
      "Cancellation is checked before starting a new attempt.",
      "repo://src/cancel.ts",
    );
    const { job } = z
      .object({
        job: z.object({
          id: z.string(),
          claimsRequiringAttention: z.array(z.object({ id: z.string() })),
        }),
      })
      .parse(await call(second, "openwiki_next_page", { runId: update.runId }));
    expect(job.claimsRequiringAttention.map(({ id }) => id)).toEqual([
      claim.id,
    ]);
    const updated =
      "Jobs receive at most seven attempts, including the initial call.";
    const oldPage = await readFile(path.join(root, "openwiki", PAGE), "utf8");
    const neighbor = await readFile(
      path.join(root, "openwiki/quickstart.md"),
      "utf8",
    );
    await write(`openwiki/${PAGE}`, oldPage.replace(baseline, updated));
    const submission = {
      runId: update.runId,
      jobId: job.id,
      claims: [
        {
          id: claim.id,
          statement: updated,
          evidence: [{ resource: "repo://src/retry.ts" }],
        },
      ],
      bindings: [
        {
          id: shared.longTerm.bindings[0].id,
          section: section.id,
          text: updated,
          claims: [claim.id],
        },
      ],
    };
    const rejected = await second.callTool({
      name: "openwiki_submit_page",
      arguments: submission,
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).toContain("reflectionResults");
    expect(
      await readFile(path.join(root, "openwiki/quickstart.md"), "utf8"),
    ).toBe(neighbor);
    for (const finding of [useful, duplicate])
      expect(await readFile(path.join(root, finding.path), "utf8")).toContain(
        FINDING,
      );
    await call(second, "openwiki_submit_page", {
      ...submission,
      reflectionResults: [useful, duplicate].map(({ id }) => ({
        id,
        claims: [claim.id],
      })),
    });
    await call(second, "openwiki_finish", { runId: update.runId });
    const consolidated = await read(second);
    expect(consolidated.longTerm.claims).toEqual([
      { id: claim.id, statement: updated },
    ]);
    expect(consolidated.longTerm.bindings[0].id).toBe(
      shared.longTerm.bindings[0].id,
    );
    expect(consolidated.longTerm.bindings[0].text).toBe(updated);
    expect(consolidated.longTerm.bindings[0].claimIds).toEqual([claim.id]);
    expect(consolidated.longTerm.sections[0].id).toBe(section.id);
    expect(consolidated.longTerm.sections[0].content).toContain(updated);
    expect(consolidated.shortTerm).toEqual({ changes: [], reflections: [] });
    expect(consolidated.working).toEqual({ changes: [], reflections: [] });
    for (const finding of captured)
      await expect(
        readFile(path.join(root, finding.path), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, arrival.path), "utf8")).toContain(
      "Cancellation",
    );
  } catch (error) {
    throw new Error(
      `Installed memory workflow failed. Server stderr:\n${diagnostics.join("")}`,
      { cause: error },
    );
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
