import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HostIntegrationError } from "../../src/integrations/core/errors.ts";
import { HostSessionManager } from "../../src/integrations/core/session-manager.ts";
import { getHostTarget } from "../../src/integrations/install/registry.ts";
import { ClaimsStore } from "../../src/claims/brains/code/store.ts";
import { parseFrontmatterFields } from "../../src/okf/frontmatter.ts";
import { OPENWIKI_PRODUCER_ACTOR } from "../../src/version.ts";

const RUN_TIMESTAMP = "2026-08-20T08:15:00.000Z";
const temporaryRoots: string[] = [];

/**
 * Persisted subset asserted by host lifecycle tests.
 */
interface PersistedRunMetadata {
  /**
   * Command associated with the metadata event.
   */
  command?: string;

  /**
   * Resolved wiki language.
   */
  language?: string;

  /**
   * Host-agent identity stored in the existing model field.
   */
  model?: string;

  /**
   * Durable lifecycle status.
   */
  status?: string;
}

/**
 * Creates an isolated repository root for a lifecycle test.
 *
 * @returns Absolute temporary repository path.
 */
async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-session-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  return root;
}

/**
 * Creates a manager with a deterministic run timestamp.
 *
 * @param host - Host identifier written to metadata.
 * @returns Validated lifecycle manager.
 */
function createManager(host = "codex"): HostSessionManager {
  return HostSessionManager.create({
    host,
    producerActor: getHostTarget(host)?.producerActor,
    now: () => new Date(RUN_TIMESTAMP),
  });
}

/**
 * Reads the repository-mode run metadata.
 *
 * @param root - Temporary repository root.
 * @returns Parsed persisted metadata.
 */
async function readMetadata(root: string): Promise<PersistedRunMetadata> {
  return JSON.parse(
    await readFile(path.join(root, "openwiki/.last-update.json"), "utf8"),
  ) as PersistedRunMetadata;
}

/**
 * Renders a valid concept page without code-owned provenance.
 *
 * @param title - Concept title and H1 text.
 * @param body - Concept body below the H1.
 * @returns Complete Markdown document.
 */
function concept(title: string, body: string): string {
  return [
    "---",
    "type: Guide",
    `title: ${title}`,
    `description: ${title} documentation.`,
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("HostSessionManager lifecycle", () => {
  test("prepares, permits native authoring, and durably finalizes a run", async () => {
    const root = await createRepository();
    const wikiRoot = path.join(root, "openwiki");
    await mkdir(path.join(wikiRoot, ".claims"), { recursive: true });
    await writeFile(
      path.join(wikiRoot, "INSTRUCTIONS.md"),
      "# Preserve this brief\n",
      "utf8",
    );
    await writeFile(
      path.join(wikiRoot, "legacy.md"),
      "# Ancien\n\nPAGE_BODY_SENTINEL\n",
      "utf8",
    );
    await writeFile(
      path.join(wikiRoot, ".claims/legacy.json"),
      "not-json\n",
      "utf8",
    );
    await writeFile(
      path.join(wikiRoot, ".last-update.json"),
      '{"status":"complete","old":true}\n',
      "utf8",
    );
    await writeFile(path.join(root, ".openwikiignore"), "private/**\n", "utf8");
    vi.stubEnv("OPENWIKI_HOST_TEST_SECRET", "ENV_VALUE_SENTINEL");

    const manager = createManager();
    const started = await manager.begin({
      root,
      mode: "init",
      language: "fr",
    });
    const canonicalRoot = await realpath(root);

    await expect(
      readFile(path.join(wikiRoot, "INSTRUCTIONS.md"), "utf8"),
    ).resolves.toBe("# Preserve this brief\n");
    await expect(
      readFile(path.join(wikiRoot, "legacy.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(wikiRoot, ".claims/legacy.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(started).toMatchObject({
      root: canonicalRoot,
      mode: "init",
      language: "fr",
      lastUpdate: null,
      ignoredPatterns: 1,
      claimsIssueCount: 0,
    });
    expect(manager.getRun(started.runId)).toMatchObject({
      id: started.runId,
      root: canonicalRoot,
      host: "codex",
      startedAt: RUN_TIMESTAMP,
    });
    expect(await readMetadata(root)).toMatchObject({
      command: "init",
      language: "fr",
      model: "host-agent/codex",
      status: "interrupted",
    });
    await expect(
      readFile(path.join(root, "AGENTS.md"), "utf8"),
    ).resolves.toContain("<!-- OPENWIKI:START -->");
    await expect(
      readFile(path.join(root, "CLAUDE.md"), "utf8"),
    ).resolves.toContain("See [AGENTS.md](AGENTS.md)");
    await expect(
      readFile(
        path.join(root, ".github/workflows/openwiki-update.yml"),
        "utf8",
      ),
    ).resolves.toContain("run: openwiki code --update --print");

    const sensitiveBody = "PAGE_BODY_SENTINEL";
    expect(JSON.stringify(started)).not.toContain(sensitiveBody);
    expect(JSON.stringify(started)).not.toContain("private/**");
    expect(JSON.stringify(started)).not.toContain("ENV_VALUE_SENTINEL");
    await writeFile(
      path.join(wikiRoot, "quickstart.md"),
      concept("Quickstart", sensitiveBody),
      "utf8",
    );
    await writeFile(
      path.join(wikiRoot, "architecture.md"),
      concept("Architecture", "Contenu neuf."),
      "utf8",
    );
    await writeFile(
      path.join(wikiRoot, "deleted.md"),
      concept("Deleted", "Temporary."),
      "utf8",
    );
    await rm(path.join(wikiRoot, "deleted.md"));
    await writeFile(path.join(wikiRoot, "_plan.md"), "Temporary plan.\n");
    await writeFile(
      path.join(wikiRoot, "_skeleton.md"),
      "Temporary skeleton.\n",
    );

    await expect(manager.finish({ runId: started.runId })).resolves.toEqual({
      status: "complete",
    });

    const quickstart = await readFile(
      path.join(wikiRoot, "quickstart.md"),
      "utf8",
    );
    const architecture = await readFile(
      path.join(wikiRoot, "architecture.md"),
      "utf8",
    );
    const index = await readFile(path.join(wikiRoot, "index.md"), "utf8");
    const generated = `generated: {by: "codex", ` + `at: "${RUN_TIMESTAMP}"}`;
    expect(quickstart).toContain(generated);
    expect(architecture).toContain(generated);
    expect(index).toContain("# Fichiers");
    expect(index).toContain("[Quickstart](quickstart.md)");
    await expect(
      readFile(path.join(wikiRoot, "legacy.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(wikiRoot, "INSTRUCTIONS.md"), "utf8"),
    ).resolves.toBe("# Preserve this brief\n");
    await expect(access(path.join(wikiRoot, "deleted.md"))).rejects.toThrow();
    await expect(access(path.join(wikiRoot, "_plan.md"))).rejects.toThrow();
    await expect(access(path.join(wikiRoot, "_skeleton.md"))).rejects.toThrow();
    expect(await readMetadata(root)).toMatchObject({
      model: "host-agent/codex",
      status: "complete",
    });
    expect(() => manager.getRun(started.runId)).toThrow(HostIntegrationError);
  });

  test("inspects, resolves, refreshes, and cleans Claims for native host edits", async () => {
    const root = await createRepository();
    const wikiRoot = path.join(root, "openwiki");
    const sourcePath = path.join(root, "README.md");
    const page = "/openwiki/page.md";
    await writeFile(sourcePath, "# Repository\n", "utf8");

    const manager = createManager();
    const initialized = await manager.begin({ root, mode: "init" });
    const resolved = (await manager.resolveClaims({
      runId: initialized.runId,
      pages: [
        {
          page,
          operations: [
            {
              op: "add",
              statement: "The repository has a README.",
              evidence: [{ resource: "repo://README.md" }],
            },
          ],
        },
      ],
    })) as {
      pages: Array<{ results: Array<{ id: string }> }>;
    };
    const claimId = resolved.pages[0]?.results[0]?.id;
    expect(claimId).toMatch(/^claim_/u);
    await mkdir(wikiRoot, { recursive: true });
    await writeFile(
      path.join(wikiRoot, "page.md"),
      concept("Page", "The repository includes a README."),
      "utf8",
    );

    await expect(manager.finish({ runId: initialized.runId })).resolves.toEqual(
      { status: "complete" },
    );
    const store = new ClaimsStore(root);
    await expect(store.loadPage(page)).resolves.toMatchObject({
      claims: [{ id: claimId, statement: "The repository has a README." }],
    });
    const initializedFields = parseFrontmatterFields(
      await readFile(path.join(wikiRoot, "page.md"), "utf8"),
    );
    expect(initializedFields?.generated).toEqual({
      by: "codex",
      at: RUN_TIMESTAMP,
    });
    expect(initializedFields?.sources).toEqual([
      expect.objectContaining({ resource: "repo://README.md" }),
    ]);
    expect(initializedFields?.verified).toEqual([
      { by: OPENWIKI_PRODUCER_ACTOR, at: RUN_TIMESTAMP },
    ]);

    await writeFile(sourcePath, "# Repository\n\nUpdated.\n", "utf8");
    const updating = await manager.begin({ root, mode: "update" });
    expect(updating.claimsIssueCount).toBe(1);
    await expect(
      manager.inspectClaims({ runId: updating.runId, ids: [claimId ?? ""] }),
    ).resolves.toMatchObject({
      pages: [
        {
          page,
          claims: [
            {
              id: claimId,
              issue: { kind: "stale", resources: ["repo://README.md"] },
            },
          ],
        },
      ],
    });
    await expect(
      manager.resolveClaims({
        runId: updating.runId,
        pages: [
          {
            page,
            operations: [{ op: "confirm", id: claimId ?? "" }],
          },
        ],
      }),
    ).resolves.toMatchObject({
      pages: [{ results: [{ op: "confirm", id: claimId }] }],
    });
    await manager.finish({ runId: updating.runId });

    const deleting = await manager.begin({ root, mode: "update" });
    await rm(path.join(wikiRoot, "page.md"));
    await manager.finish({ runId: deleting.runId });
    await expect(store.loadPage(page)).resolves.toBeNull();
  });

  test("retains interrupted state and the active session for a finish retry", async () => {
    const root = await createRepository();
    const wikiRoot = path.join(root, "openwiki");
    await mkdir(wikiRoot, { recursive: true });
    await writeFile(
      path.join(wikiRoot, "page.md"),
      concept("Page", "Body."),
      "utf8",
    );
    const manager = createManager();
    const started = await manager.begin({ root, mode: "init" });

    const blockingIndex = path.join(wikiRoot, "index.md");
    await mkdir(blockingIndex);
    await expect(manager.finish({ runId: started.runId })).rejects.toThrow();

    expect(await readMetadata(root)).toMatchObject({ status: "interrupted" });
    expect(manager.getRun(started.runId).id).toBe(started.runId);

    await rm(blockingIndex, { recursive: true, force: true });
    await expect(manager.finish({ runId: started.runId })).resolves.toEqual({
      status: "complete",
    });
    expect(await readMetadata(root)).toMatchObject({ status: "complete" });
  });

  test("refreshes agent instructions on update without creating a workflow", async () => {
    const root = await createRepository();
    const manager = createManager();

    const started = await manager.begin({ root, mode: "update" });

    await expect(
      readFile(path.join(root, "AGENTS.md"), "utf8"),
    ).resolves.toContain("<!-- OPENWIKI:START -->");
    await expect(
      readFile(path.join(root, "CLAUDE.md"), "utf8"),
    ).resolves.toContain("See [AGENTS.md](AGENTS.md)");
    await expect(
      access(path.join(root, ".github/workflows/openwiki-update.yml")),
    ).rejects.toThrow();

    await manager.finish({ runId: started.runId });
  });

  test.each([
    ["codex", "codex"],
    ["claude", "claude-code"],
    ["custom-host", "custom-host"],
  ])("stamps %s-authored bodies with the %s actor", async (host, actor) => {
    const root = await createRepository();
    const manager = createManager(host);
    const started = await manager.begin({ root, mode: "init" });
    await writeFile(
      path.join(root, "openwiki/page.md"),
      concept("Page", "Host-authored body."),
      "utf8",
    );

    await manager.finish({ runId: started.runId });

    await expect(
      readFile(path.join(root, "openwiki/page.md"), "utf8"),
    ).resolves.toContain(`generated: {by: "${actor}"`);
  });

  test("a second begin may select a new root without reverting old Markdown", async () => {
    const root = await createRepository();
    const replacementRoot = await createRepository();
    const wikiRoot = path.join(root, "openwiki");
    const manager = createManager();
    const first = await manager.begin({ root, mode: "init" });
    await writeFile(
      path.join(wikiRoot, "preserved.md"),
      concept("Preserved", "Authored before replacement."),
      "utf8",
    );

    const second = await manager.begin({ root: replacementRoot, mode: "init" });

    expect(second.runId).not.toBe(first.runId);
    expect(second.root).toBe(await realpath(replacementRoot));
    expect(() => manager.getRun(first.runId)).toThrow(HostIntegrationError);
    await expect(
      readFile(path.join(wikiRoot, "preserved.md"), "utf8"),
    ).resolves.toContain("Authored before replacement.");
    expect(await readMetadata(root)).toMatchObject({ status: "interrupted" });
    await manager.finish({ runId: second.runId });
  });

  test("a failed replacement begin preserves the active run", async () => {
    const root = await createRepository();
    const manager = createManager();
    const active = await manager.begin({ root, mode: "init" });

    await expect(
      manager.begin({ root: path.join(root, "missing"), mode: "update" }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(manager.getRun(active.runId).id).toBe(active.runId);
    await expect(manager.finish({ runId: active.runId })).resolves.toEqual({
      status: "complete",
    });
  });

  test("rejects overlapping lifecycle operations", async () => {
    const root = await createRepository();
    const manager = createManager();

    const beginning = manager.begin({ root, mode: "init" });
    await expect(manager.begin({ root, mode: "update" })).rejects.toMatchObject(
      {
        code: "invalid_state",
        message: "Another OpenWiki lifecycle operation is already in progress.",
      },
    );
    const active = await beginning;

    const finishing = manager.finish({ runId: active.runId });
    await expect(manager.finish({ runId: active.runId })).rejects.toMatchObject(
      {
        code: "invalid_state",
      },
    );
    await expect(finishing).resolves.toEqual({ status: "complete" });
  });

  test("releases the lifecycle lock when run initialization throws", async () => {
    const root = await createRepository();
    let clockCalls = 0;
    const manager = HostSessionManager.create({
      host: "codex",
      now: () =>
        clockCalls++ === 0 ? new Date(Number.NaN) : new Date(RUN_TIMESTAMP),
    });

    await expect(manager.begin({ root, mode: "init" })).rejects.toThrow(
      RangeError,
    );
    const active = await manager.begin({ root, mode: "init" });
    await expect(manager.finish({ runId: active.runId })).resolves.toEqual({
      status: "complete",
    });
  });

  test("a new manager recovers interrupted update metadata and authored Markdown", async () => {
    const root = await createRepository();
    const wikiRoot = path.join(root, "openwiki");
    const abandonedManager = createManager("codex");
    await abandonedManager.begin({ root, mode: "update" });
    await writeFile(
      path.join(wikiRoot, "recovered.md"),
      concept("Recovered", "Survives process exit."),
      "utf8",
    );

    const recoveryManager = createManager("claude-code");
    const recovered = await recoveryManager.begin({ root, mode: "update" });

    expect(recovered.lastUpdate).toMatchObject({ status: "interrupted" });
    await expect(
      readFile(path.join(wikiRoot, "recovered.md"), "utf8"),
    ).resolves.toContain("Survives process exit.");
    await recoveryManager.finish({ runId: recovered.runId });
    expect(await readMetadata(root)).toMatchObject({
      model: "host-agent/claude-code",
      status: "complete",
    });
  });
});

describe("HostSessionManager validation", () => {
  test("rejects invalid host identifiers with a bounded error", () => {
    expect(() => HostSessionManager.create({ host: "Codex Agent" })).toThrow(
      expect.objectContaining({
        name: "HostIntegrationError",
        code: "invalid_input",
        message:
          "The host ID must contain lowercase letters, digits, or hyphens.",
      }),
    );
    expect(() =>
      HostSessionManager.create({
        host: "codex",
        producerActor: "Codex Agent",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message:
          "The producer actor must contain lowercase letters, digits, or hyphens.",
      }),
    );
  });

  test("rejects invalid roots without exposing the candidate path", async () => {
    const root = await createRepository();
    const missing = path.join(root, "private-root-name");

    const manager = HostSessionManager.create({ host: "codex" });
    const error: unknown = await manager
      .begin({ root: missing, mode: "init" })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      name: "HostIntegrationError",
      code: "invalid_input",
      message: "The OpenWiki root must be an existing directory.",
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("private-root-name");
  });
});
