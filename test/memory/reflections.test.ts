import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { ClaimsStore } from "../../src/claims/brains/code/store.ts";
import { RepositoryEvidenceResolver } from "../../src/claims/evidence/repository/resolver.ts";
import { HostSessionManager } from "../../src/integrations/core/session-manager.ts";
import { createOpenWikiMcpServer } from "../../src/integrations/mcp/server.ts";
import {
  orientReflections,
  outlineReflections,
  readReflections,
} from "../../src/memory/reflection-retrieval.ts";
import {
  REFLECTIONS_DIRECTORY,
  ReflectionSchema,
  type ReflectionCreated,
} from "../../src/memory/reflection-types.ts";
import { ReflectionStore } from "../../src/memory/reflections.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof crypto>();
  return { ...original, randomUUID: vi.fn(original.randomUUID) };
});

/**
 * Temporary repositories owned by the current test, including any shallow clone.
 */
const roots: string[] = [];

/**
 * Current isolated repository.
 */
let root: string;

/**
 * Linked wiki page with independent retry and cancellation sections.
 */
const PAGE = "concepts/jobs.md";

/**
 * Discovery deliberately adds a condition to the existing retry claim.
 */
const FINDING =
  "The retry limit includes the initial attempt; configure three for two retries.";

/**
 * Executes Git without relying on the developer's identity or signing configuration.
 *
 * @param args - Literal Git arguments.
 * @returns Trimmed command output.
 */
function git(...args: string[]): string {
  return execFileSync(
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
    {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    },
  ).trim();
}

/**
 * Writes an isolated fixture file and its parent directory.
 *
 * @param file - Repository-relative path.
 * @param content - Complete file contents.
 */
async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

/**
 * Commits the fixture's current state.
 *
 * @param message - Commit purpose.
 */
function commit(message: string): void {
  git("add", ".");
  git("commit", "--quiet", "-m", message);
}

/**
 * Records a finding through the production evidence and storage boundaries.
 *
 * @param resource - Supporting source resource.
 * @param finding - Repository-specific discovery.
 * @returns Persisted artifact identity.
 */
function reflect(
  resource = "repo://src/retry.ts#L1",
  finding = FINDING,
): Promise<ReflectionCreated> {
  return new ReflectionStore(root).create({
    finding,
    evidence: [{ resource }],
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openwiki-reflection-tests-"));
  roots.push(root);
  git("init", "--quiet", "-b", "main");
  await write(
    "src/retry.ts",
    "export const attempts = 3;\nexport const initialAttemptCounts = true;\n",
  );
  await write("src/cancel.ts", "export const cancel = true;\n");
  await write("src/new.ts", "export const discovered = true;\n");
  commit("source baseline");
  const checkpoint = git("rev-parse", "HEAD");
  await write(
    "openwiki/quickstart.md",
    "---\ntitle: Quickstart\ndescription: Repository orientation.\n---\n# Quickstart\n\nAcme runs jobs.\n",
  );
  await write(
    `openwiki/${PAGE}`,
    "---\ntype: concept\ntitle: Jobs\ndescription: Retries and cancellation.\n---\n# Jobs\n\n## Retries\n\nJobs receive three attempts.\n\n## Cancellation\n\nCancellation stops new attempts.\n",
  );
  const store = new ClaimsStore(root);
  await store.writePage(`/openwiki/${PAGE}`, {
    schemaVersion: 1,
    pageVersion: await store.hashPage(`/openwiki/${PAGE}`),
    claims: [
      {
        id: "claim_retry",
        statement: "Jobs receive three attempts.",
        evidence: [
          { resource: "repo://src/retry.ts#L1-L1", version: "retry-v1" },
        ],
      },
      {
        id: "claim_cancel",
        statement: "Cancellation stops new attempts.",
        evidence: [{ resource: "repo://src/cancel.ts", version: "cancel-v1" }],
      },
    ],
    sections: [
      {
        id: "section_jobs",
        location: `${PAGE}#Jobs`,
        description: "Job lifecycle.",
      },
      {
        id: "section_retry",
        location: `${PAGE}#Jobs#Retries`,
        description: "Attempt limits.",
      },
      {
        id: "section_cancel",
        location: `${PAGE}#Jobs#Cancellation`,
        description: "Cancellation behavior.",
      },
    ],
    bindings: [
      {
        id: "binding_retry",
        sectionId: "section_retry",
        text: "Jobs receive three attempts.",
        claimIds: ["claim_retry"],
      },
      {
        id: "binding_cancel",
        sectionId: "section_cancel",
        text: "Cancellation stops new attempts.",
        claimIds: ["claim_cancel"],
      },
    ],
  });
  await write(
    "openwiki/.last-update.json",
    JSON.stringify({
      updatedAt: "2026-09-06T12:00:00Z",
      command: "init",
      model: "test",
      gitHead: checkpoint,
      status: "complete",
    }),
  );
  commit("wiki baseline");
});

afterEach(async () => {
  vi.mocked(crypto.randomUUID).mockReset();
  await Promise.all(
    roots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("reflection capture", () => {
  test("captures canonical versioned evidence with only the agreed persisted fields", async () => {
    const created = await reflect(undefined, `  ${FINDING}  `);
    expect(created.id).toMatch(/^reflection-[a-f0-9-]{36}$/u);
    expect(created).toEqual({
      id: created.id,
      path: `${REFLECTIONS_DIRECTORY}/${created.id}.json`,
    });
    const resolved = await new RepositoryEvidenceResolver({
      rootDir: root,
    }).resolve("repo://src/retry.ts#L1-L1");
    const content = await readFile(path.join(root, created.path), "utf8");
    expect(JSON.parse(content)).toEqual({
      id: created.id,
      finding: FINDING,
      evidence: [resolved!.evidence],
    });
    expect(content.endsWith("\n")).toBe(true);
    expect(await readdir(path.join(root, REFLECTIONS_DIRECTORY))).toEqual([
      `${created.id}.json`,
    ]);
    await rm(path.join(root, "src/retry.ts"));
    expect((await new ReflectionStore(root).list()).reflections).toEqual([
      JSON.parse(content),
    ]);
  });

  test.each([
    "repo://missing.ts",
    "repo://src/retry.ts#L50-L60",
    "repo://../outside.ts",
    "src/retry.ts",
  ])(
    "rejects unresolved evidence %s before publishing anything",
    async (resource) => {
      await expect(reflect(resource)).rejects.toThrow(/evidence|Evidence/u);
      expect(await new ReflectionStore(root).list()).toEqual({
        reflections: [],
      });
      expect(await readdir(path.join(root, "openwiki"))).not.toContain(
        ".reflections",
      );
    },
  );

  test("enforces ignore rules and source containment", async () => {
    await write(".openwikiignore", "src/retry.ts\n");
    await expect(reflect()).rejects.toThrow(/evidence|Evidence/u);
    await symlink(
      path.join(root, "src/cancel.ts"),
      path.join(root, "src/alias.ts"),
    );
    await expect(reflect("repo://src/alias.ts")).rejects.toThrow(
      /evidence|Evidence/u,
    );
    expect((await new ReflectionStore(root).list()).reflections).toEqual([]);
  });

  test("rejects invalid proposals and repeated canonical evidence resources", async () => {
    const store = new ReflectionStore(root);
    for (const proposal of [
      { finding: " ", evidence: [{ resource: "repo://src/retry.ts" }] },
      { finding: FINDING, evidence: [] },
      {
        finding: FINDING,
        evidence: [
          { resource: "repo://src/retry.ts", version: "agent-chosen" },
        ],
      },
    ])
      await expect(store.create(proposal)).rejects.toThrow("non-empty finding");
    await expect(
      store.create({
        finding: FINDING,
        evidence: [
          { resource: "repo://src/retry.ts#L1" },
          { resource: "repo://src/retry.ts#L1-L1" },
        ],
      }),
    ).rejects.toThrow("repeated resource");
    expect(await store.list()).toEqual({ reflections: [] });
  });

  test("publishes concurrent discoveries independently without a shared index or temporary artifacts", async () => {
    const created = await Promise.all(
      Array.from({ length: 12 }, () => reflect()),
    );
    expect(new Set(created.map(({ id }) => id)).size).toBe(12);
    expect(
      (await readdir(path.join(root, REFLECTIONS_DIRECTORY))).sort(),
    ).toEqual(created.map(({ id }) => `${id}.json`).sort());
    const inventory = await new ReflectionStore(root).list();
    expect(inventory.unavailable).toBeUndefined();
    expect(inventory.reflections).toHaveLength(12);
  });

  test("refuses a UUID collision without replacing the previous finding", async () => {
    const original = await reflect();
    const content = await readFile(path.join(root, original.path), "utf8");
    vi.mocked(crypto.randomUUID).mockReturnValue(
      original.id.slice("reflection-".length) as ReturnType<
        typeof crypto.randomUUID
      >,
    );
    await expect(
      reflect("repo://src/cancel.ts", "Another finding."),
    ).rejects.toThrow("existing reflections were preserved");
    expect(await readFile(path.join(root, original.path), "utf8")).toBe(
      content,
    );
    expect(await readdir(path.join(root, REFLECTIONS_DIRECTORY))).toEqual([
      `${original.id}.json`,
    ]);
  });

  test("reports malformed and aliased records while retaining readable neighbors", async () => {
    const valid = await reflect();
    const corrupt = await reflect();
    const mismatch = await reflect();
    const alias = await reflect();
    await write(corrupt.path, "private malformed data");
    await write(
      mismatch.path,
      await readFile(path.join(root, valid.path), "utf8"),
    );
    await rm(path.join(root, alias.path));
    await symlink(path.join(root, valid.path), path.join(root, alias.path));
    await write(`${REFLECTIONS_DIRECTORY}/.pending.tmp`, "unfinished JSON");
    const inventory = await new ReflectionStore(root).list();
    expect(inventory.reflections.map(({ id }) => id)).toEqual([valid.id]);
    for (const failed of [corrupt, mismatch, alias])
      expect(inventory.unavailable).toContain(`${failed.id}.json`);
    expect(JSON.stringify(inventory)).not.toContain("private malformed data");
  });

  test("does not read or write through an aliased reflection directory", async () => {
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "openwiki-reflection-outside-"),
    );
    roots.push(outside);
    await symlink(outside, path.join(root, REFLECTIONS_DIRECTORY));
    await expect(reflect()).rejects.toThrow("real directories");
    expect(await readdir(outside)).toEqual([]);
    const inventory = await new ReflectionStore(root).list();
    expect(inventory.reflections).toEqual([]);
    expect(inventory.unavailable).toContain("could not be read safely");
  });
});

describe("reflection retrieval", () => {
  test("separates main and working findings and progressively narrows their connections", async () => {
    const shared = await reflect();
    expect((await orientReflections(root, [PAGE])).working).toEqual([
      { id: shared.id, finding: FINDING, relatedPages: [PAGE] },
    ]);
    commit("share finding on main");
    git("checkout", "--quiet", "-b", "feature");
    const local = await reflect(
      "repo://src/cancel.ts",
      "Cancellation stops future attempts, but leaves a running attempt active.",
    );
    const uncovered = await reflect(
      "repo://src/new.ts",
      "The new module has no wiki coverage yet.",
    );
    const orient = await orientReflections(root, [PAGE, "quickstart.md"]);
    expect(orient.shortTerm.map(({ id }) => id)).toEqual([shared.id]);
    expect(orient.working.map(({ id }) => id).sort()).toEqual(
      [local.id, uncovered.id].sort(),
    );
    expect(
      orient.working.find(({ id }) => id === uncovered.id)?.relatedPages,
    ).toEqual([]);
    expect(orient.unclassifiedReflections).toBeUndefined();
    const outline = await outlineReflections(root, PAGE);
    expect(outline.shortTerm).toEqual([
      { id: shared.id, finding: FINDING, relatedSectionIds: ["section_retry"] },
    ]);
    expect(outline.working).toEqual([
      {
        id: local.id,
        finding:
          "Cancellation stops future attempts, but leaves a running attempt active.",
        relatedSectionIds: ["section_cancel"],
      },
    ]);
    expect(await readReflections(root, PAGE, ["section_retry"])).toEqual({
      shortTerm: [
        {
          id: shared.id,
          finding: FINDING,
          evidence: [{ resource: "repo://src/retry.ts#L1-L1" }],
          relatedClaimIds: ["claim_retry"],
        },
      ],
      working: [],
    });
  });

  test("connects by shared source files and deduplicates overlapping relationships", async () => {
    const created = await new ReflectionStore(root).create({
      finding: FINDING,
      evidence: [
        { resource: "repo://src/retry.ts#L2" },
        { resource: "repo://src/retry.ts" },
        { resource: "repo://src/cancel.ts" },
      ],
    });
    expect((await orientReflections(root, [PAGE])).working).toEqual([
      { id: created.id, finding: FINDING, relatedPages: [PAGE] },
    ]);
    expect(
      (await outlineReflections(root, PAGE)).working[0].relatedSectionIds,
    ).toEqual(["section_cancel", "section_retry"]);
    expect(
      (await readReflections(root, PAGE, ["section_retry"])).working[0]
        .relatedClaimIds,
    ).toEqual(["claim_retry"]);
  });

  test("retrieves only local files and recognizes a pulled main reflection before merging its commit", async () => {
    const older = git("rev-parse", "HEAD");
    const shared = await reflect();
    const content = await readFile(path.join(root, shared.path), "utf8");
    commit("share new finding");
    git("checkout", "--quiet", "-b", "older-work", older);
    expect(await orientReflections(root, [PAGE])).toEqual({
      shortTerm: [],
      working: [],
    });
    await write(shared.path, content);
    expect(
      (await orientReflections(root, [PAGE])).shortTerm.map(({ id }) => id),
    ).toEqual([shared.id]);
    expect(git("status", "--porcelain")).toContain(".reflections");
  });

  test("recognizes a historical main finding still present on an older branch", async () => {
    const shared = await reflect();
    commit("share finding");
    const previous = git("rev-parse", "HEAD");
    await rm(path.join(root, shared.path));
    commit("remove finding from main");
    git("checkout", "--quiet", "-b", "older-work", previous);
    expect(
      (await orientReflections(root, [PAGE])).shortTerm.map(({ id }) => id),
    ).toEqual([shared.id]);
  });

  test("compares canonical records without confusing a changed finding with the original main record", async () => {
    const shared = await reflect();
    commit("share finding");
    const stored = ReflectionSchema.parse(
      JSON.parse(await readFile(path.join(root, shared.path), "utf8")),
    );
    await write(
      shared.path,
      JSON.stringify({
        evidence: stored.evidence,
        finding: stored.finding,
        id: stored.id,
      }),
    );
    expect((await orientReflections(root, [PAGE])).shortTerm).toHaveLength(1);
    await write(
      shared.path,
      JSON.stringify({ ...stored, finding: "A different unsupported edit." }),
    );
    expect((await orientReflections(root, [PAGE])).working).toHaveLength(1);
  });

  test("preserves readable findings without inventing an origin when main cannot be resolved", async () => {
    const local = await reflect();
    git("branch", "-m", "feature");
    const result = await orientReflections(root, [PAGE]);
    expect(result.unclassifiedReflections?.unavailable).toBeTruthy();
    expect(result).toEqual({
      shortTerm: [],
      working: [],
      unclassifiedReflections: {
        unavailable: result.unclassifiedReflections!.unavailable,
        reflections: [{ id: local.id, finding: FINDING, relatedPages: [PAGE] }],
      },
    });
    expect(
      (await readReflections(root, PAGE, ["section_retry"]))
        .unclassifiedReflections?.reflections[0],
    ).toEqual({
      id: local.id,
      finding: FINDING,
      evidence: [{ resource: "repo://src/retry.ts#L1-L1" }],
      relatedClaimIds: ["claim_retry"],
    });
  });

  test("keeps known findings classified when shallow history leaves another origin unknown", async () => {
    const shared = await reflect();
    commit("share finding");
    const origin = root;
    const clone = await mkdtemp(
      path.join(os.tmpdir(), "openwiki-reflection-shallow-"),
    );
    roots.push(clone);
    git("clone", "--quiet", "--depth", "1", `file://${origin}`, clone);
    root = clone;
    const local = await reflect(
      "repo://src/cancel.ts",
      "Cancellation discovery.",
    );
    const result = await orientReflections(root, [PAGE]);
    expect(result.shortTerm.map(({ id }) => id)).toEqual([shared.id]);
    expect(result.working).toEqual([]);
    expect(
      result.unclassifiedReflections?.reflections.map(({ id }) => id),
    ).toEqual([local.id]);
    expect(result.unclassifiedReflections?.unavailable).toContain("shallow");
  });

  test("exposes inventory gaps without hiding valid classified findings", async () => {
    const valid = await reflect();
    await write(`${REFLECTIONS_DIRECTORY}/invalid.json`, "not valid");
    const result = await orientReflections(root, [PAGE]);
    expect(result.working.map(({ id }) => id)).toEqual([valid.id]);
    expect(result.unclassifiedReflections?.unavailable).toContain(
      "invalid.json",
    );
    expect(result.unclassifiedReflections?.reflections).toEqual([]);
    await rm(path.join(root, valid.path));
    expect(
      (await orientReflections(root, [PAGE])).unclassifiedReflections
        ?.unavailable,
    ).toContain("invalid.json");
  });

  test("retains discoveries when wiki connections cannot be read", async () => {
    const local = await reflect();
    await write(
      "openwiki/.claims/concepts/jobs.json",
      "private invalid sidecar",
    );
    const result = await orientReflections(root, [PAGE]);
    expect(result.unclassifiedReflections?.reflections).toEqual([
      { id: local.id, finding: FINDING, relatedPages: [] },
    ]);
    expect(JSON.stringify(result)).not.toContain("private invalid sidecar");
  });

  test("recovers from rejected MCP capture and returns findings through every retrieval tool without starting a run", async () => {
    const server = createOpenWikiMcpServer(
      HostSessionManager.create({ host: "codex" }),
    );
    const client = new Client({ name: "reflection-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect(
        (await client.listTools()).tools.map(({ name }) => name),
      ).toContain("openwiki_reflect");
      const rejected = await client.callTool({
        name: "openwiki_reflect",
        arguments: {
          root,
          finding: FINDING,
          evidence: [{ resource: "repo://missing.ts" }],
        },
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected.content)).toContain(
        "retry openwiki_reflect",
      );
      const created = await client.callTool({
        name: "openwiki_reflect",
        arguments: {
          root,
          finding: FINDING,
          evidence: [{ resource: "repo://src/retry.ts#L1" }],
        },
      });
      expect(created.isError).not.toBe(true);
      const { id } = z
        .object({ id: z.string(), path: z.string() })
        .strict()
        .parse(created.structuredContent);
      await rm(path.join(root, "openwiki/.last-update.json"));
      for (const [name, args, expected] of [
        ["openwiki_orient", { root }, { relatedPages: [PAGE] }],
        [
          "openwiki_outline",
          { root, page: PAGE },
          { relatedSectionIds: ["section_retry"] },
        ],
        [
          "openwiki_read",
          { root, page: PAGE, sections: ["section_jobs"] },
          {
            relatedClaimIds: ["claim_retry"],
            evidence: [{ resource: "repo://src/retry.ts#L1-L1" }],
          },
        ],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toHaveProperty("longTerm");
        expect(result.structuredContent?.shortTerm).toHaveProperty(
          "unavailable",
        );
        expect(result.structuredContent).toMatchObject({
          shortTerm: { reflections: [] },
          working: { reflections: [{ id, finding: FINDING, ...expected }] },
        });
        expect(result.structuredContent).not.toHaveProperty(
          "unclassifiedReflections",
        );
        expect(result.content).toEqual([
          { type: "text", text: JSON.stringify(result.structuredContent) },
        ]);
      }
      expect(await readdir(path.join(root, "openwiki"))).not.toContain(
        ".run.json",
      );
    } finally {
      await client.close();
      if (server.isConnected()) await server.close();
    }
  });
});
