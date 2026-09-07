import { execFileSync } from "node:child_process";
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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { reconcilePageProse } from "../../src/claims/brains/code/prose.ts";
import { parseMarkdownSections } from "../../src/claims/brains/code/sections.ts";
import { ClaimsStore } from "../../src/claims/brains/code/store.ts";
import type { Claim } from "../../src/claims/core/types.ts";
import { HostSessionManager } from "../../src/integrations/core/session-manager.ts";
import { createOpenWikiMcpServer } from "../../src/integrations/mcp/server.ts";
import {
  orientWiki,
  outlineWiki,
  readWiki,
} from "../../src/memory/retrieval.ts";

/**
 * Repository-local page used for selection and evidence tests.
 */
const PAGE = "concepts/jobs.md";

/**
 * Nested headings, overlapping claim coverage, and an unrelated sibling topic.
 */
const MARKDOWN = `---
type: concept
title: Job lifecycle
description: Job execution, retry limits, and cancellation.
---
# Jobs

Workers execute jobs.

## Failures

Failed jobs have a bounded retry budget.

### Retries

Jobs receive three attempts.

## Cancellation

Cancellation stops new attempts.
`;

/**
 * Source resources intentionally need not exist for consolidated wiki retrieval.
 */
const CLAIMS: Claim[] = [
  {
    id: "claim_worker",
    statement: "Workers execute jobs.",
    evidence: [
      { resource: "repo://src/worker.ts#L2-L8", version: "worker-v1" },
    ],
  },
  {
    id: "claim_retry",
    statement: "Jobs receive three attempts.",
    evidence: [
      { resource: "repo://src/retry.ts#L12-L20", version: "retry-v1" },
    ],
  },
  {
    id: "claim_cancel",
    statement: "Cancellation stops new attempts.",
    evidence: [{ resource: "repo://src/cancel.ts", version: "cancel-v1" }],
  },
];

/**
 * Isolated repository shared only within the current test.
 */
let root: string;

/**
 * Writes a fixture through production reconciliation and persistence boundaries.
 *
 * @param markdown - Complete replacement job page.
 * @returns Valid persisted sidecar with stable identities for test selectors.
 */
async function writeLinkedPage(markdown = MARKDOWN) {
  const canonical = `/openwiki/${PAGE}`;
  await mkdir(path.join(root, "openwiki/concepts"), { recursive: true });
  await writeFile(path.join(root, "openwiki", PAGE), markdown);
  const prose = reconcilePageProse(canonical, markdown, undefined, CLAIMS, {
    sections: parseMarkdownSections(canonical, markdown).map(
      ({ location, title }) => ({
        location,
        description: `Scope of ${title || "the introduction"}.`,
      }),
    ),
    bindings: [
      {
        section: `${PAGE}#Jobs`,
        text: "Workers execute jobs.",
        claims: ["claim_worker"],
      },
      {
        section: `${PAGE}#Jobs#Failures`,
        text: "Failed jobs have a bounded retry budget.",
        claims: ["claim_retry"],
      },
      {
        section: `${PAGE}#Jobs#Failures#Retries`,
        text: "Jobs receive three attempts.",
        claims: ["claim_retry"],
      },
      {
        section: `${PAGE}#Jobs#Cancellation`,
        text: "Cancellation stops new attempts.",
        claims: ["claim_cancel"],
      },
    ],
  });
  const store = new ClaimsStore(root);
  const state = {
    schemaVersion: 1,
    pageVersion: await store.hashPage(canonical),
    claims: CLAIMS,
    ...prose,
  };
  await store.writePage(canonical, state);
  return state;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openwiki-retrieval-"));
  execFileSync("git", ["init", "--quiet", root]);
  await mkdir(path.join(root, "openwiki"));
  await writeFile(
    path.join(root, "openwiki/quickstart.md"),
    `---
type: orientation
title: Quickstart
description: Find the right job service documentation.
---
# Quickstart

Acme runs background jobs through a queue and worker pool.

## Navigation

Read [Jobs](concepts/jobs.md).
`,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("consolidated wiki retrieval", () => {
  test("orients from the opening prose and authored directory without reading sidecars", async () => {
    await writeLinkedPage();
    await writeFile(
      path.join(root, "openwiki/.claims/concepts/jobs.json"),
      "not JSON",
    );
    for (const file of [
      "index.md",
      "instructions.md",
      "log.md",
      "concepts/index.md",
    ]) {
      await writeFile(path.join(root, "openwiki", file), "Structural page.");
    }
    expect(await orientWiki(root)).toEqual({
      overview: "Acme runs background jobs through a queue and worker pool.",
      pages: [
        {
          page: PAGE,
          title: "Job lifecycle",
          description: "Job execution, retry limits, and cancellation.",
        },
        {
          page: "quickstart.md",
          title: "Quickstart",
          description: "Find the right job service documentation.",
        },
      ],
    });
  });

  test("outlines in document order even when sidecar sections are stored in reverse", async () => {
    const state = await writeLinkedPage();
    await new ClaimsStore(root).writePage(`/openwiki/${PAGE}`, {
      ...state,
      sections: [...state.sections].reverse(),
    });
    expect(await outlineWiki(root, PAGE)).toEqual({
      page: PAGE,
      title: "Job lifecycle",
      description: "Job execution, retry limits, and cancellation.",
      sections: state.sections.map((section, index) => ({
        ...section,
        title: ["Jobs", "Failures", "Retries", "Cancellation"][index],
      })),
    });
  });

  test("reads a leaf with only its bindings and resource-only claim evidence", async () => {
    const state = await writeLinkedPage();
    const section = state.sections[2];
    expect(await readWiki(root, PAGE, [section.id])).toEqual({
      page: PAGE,
      sections: [
        {
          id: section.id,
          location: section.location,
          content: "### Retries\n\nJobs receive three attempts.\n\n",
        },
      ],
      bindings: [state.bindings[2]],
      claims: [
        {
          id: "claim_retry",
          statement: "Jobs receive three attempts.",
          evidence: [{ resource: "repo://src/retry.ts#L12-L20" }],
        },
      ],
    });
  });

  test("includes descendants once and deduplicates claims across overlapping selections", async () => {
    const state = await writeLinkedPage();
    const result = await readWiki(root, PAGE, [
      state.sections[2].id,
      state.sections[1].id,
      state.sections[1].id,
    ]);
    expect(result.sections.map(({ id }) => id)).toEqual([
      state.sections[1].id,
      state.sections[2].id,
    ]);
    expect(result.sections[0].content).toBe(
      "## Failures\n\nFailed jobs have a bounded retry budget.\n\n",
    );
    expect(result.sections[1].content).toBe(
      "### Retries\n\nJobs receive three attempts.\n\n",
    );
    expect(result.bindings).toEqual(state.bindings.slice(1, 3));
    expect(result.claims.map(({ id }) => id)).toEqual(["claim_retry"]);
  });

  test("reads the whole body without frontmatter when selectors are omitted", async () => {
    const state = await writeLinkedPage();
    const result = await readWiki(root, PAGE);
    expect(result.sections.map(({ content }) => content).join("")).toBe(
      MARKDOWN.slice(MARKDOWN.indexOf("# Jobs")),
    );
    expect(result.bindings).toEqual(state.bindings);
    expect(result.claims.map(({ id }) => id)).toEqual(
      CLAIMS.map(({ id }) => id),
    );
  });

  test("preserves setext headings, fenced content, and LF-normalized unheaded prose", async () => {
    const markdown = MARKDOWN.replace(
      "# Jobs",
      "Preamble.\n\nJobs\n====",
    ).replace(
      "Jobs receive three attempts.\n",
      "Jobs receive three attempts.\n\n```md\n## Not a section\n```\n",
    );
    const state = await writeLinkedPage(markdown.replace(/\n/gu, "\r\n"));
    const whole = await readWiki(root, PAGE);
    expect(whole.sections).toHaveLength(5);
    expect(whole.sections.map(({ content }) => content).join("")).toBe(
      markdown.slice(markdown.indexOf("Preamble.")),
    );
    const preamble = await readWiki(root, PAGE, [state.sections[0].id]);
    expect(preamble.sections).toEqual([
      { id: state.sections[0].id, location: PAGE, content: "Preamble.\n\n" },
    ]);
    expect(preamble.bindings).toEqual([]);
    expect(preamble.claims).toEqual([]);
  });

  test("keeps renamed sections addressable by the same stable ID", async () => {
    const state = await writeLinkedPage();
    const markdown = MARKDOWN.replace("### Retries", "### Retry limits");
    const section = state.sections[2];
    const prose = reconcilePageProse(
      `/openwiki/${PAGE}`,
      markdown,
      state,
      CLAIMS,
      {
        sections: [
          { ...section, location: `${PAGE}#Jobs#Failures#Retrylimits` },
        ],
      },
    );
    await writeFile(path.join(root, "openwiki", PAGE), markdown);
    await new ClaimsStore(root).writePage(`/openwiki/${PAGE}`, {
      ...state,
      ...prose,
    });
    const result = await readWiki(root, PAGE, [section.id]);
    expect(result.sections[0]).toEqual({
      id: section.id,
      location: `${PAGE}#Jobs#Failures#Retrylimits`,
      content: "### Retry limits\n\nJobs receive three attempts.\n\n",
    });
  });

  test("rejects unknown IDs instead of returning a partial selection", async () => {
    const state = await writeLinkedPage();
    await expect(
      readWiki(root, PAGE, [state.sections[0].id, "missing"]),
    ).rejects.toThrow("Unknown section IDs: missing. Call openwiki_outline");
    await expect(readWiki(root, PAGE, [])).rejects.toThrow(
      "omit sections to read the whole page",
    );
  });

  test("reports missing or legacy linkage without creating metadata", async () => {
    await expect(outlineWiki(root, "quickstart.md")).rejects.toThrow(
      "Include this page in an OpenWiki update",
    );
    await expect(readWiki(root, "quickstart.md")).rejects.toThrow(
      "no complete section and binding metadata",
    );
    expect(await readdir(path.join(root, "openwiki"))).toEqual([
      "quickstart.md",
    ]);
    const state = await writeLinkedPage();
    await new ClaimsStore(root).writePage(`/openwiki/${PAGE}`, {
      schemaVersion: 1,
      pageVersion: state.pageVersion,
      claims: state.claims,
    });
    await expect(readWiki(root, PAGE)).rejects.toThrow(
      "no complete section and binding metadata",
    );
  });

  test.each([
    ["renamed heading", MARKDOWN.replace("## Failures", "## Faults")],
    [
      "removed passage",
      MARKDOWN.replace("Jobs receive three attempts.", "Five attempts."),
    ],
  ])("reports inconsistent linkage after a %s", async (_label, markdown) => {
    await writeLinkedPage();
    await writeFile(path.join(root, "openwiki", PAGE), markdown);
    await expect(readWiki(root, PAGE)).rejects.toThrow("reconcile its links");
  });

  test("requires authored page metadata and an opening quickstart summary", async () => {
    await writeFile(
      path.join(root, "openwiki/quickstart.md"),
      "# Quickstart\n\n## Navigation\n\nPages.\n",
    );
    await expect(orientWiki(root)).rejects.toThrow(
      "no opening repository summary",
    );
    await writeFile(
      path.join(root, "openwiki/quickstart.md"),
      "# Quickstart\n\nRepository introduction.\n",
    );
    await expect(orientWiki(root)).rejects.toThrow("title and description");
  });

  test("reports missing pages and refuses traversal, structural files, and aliases", async () => {
    await expect(readWiki(root, "missing.md")).rejects.toThrow(
      "use openwiki_orient",
    );
    for (const page of [
      "../outside.md",
      "concepts/../jobs.md",
      "index.md",
      ".claims/page.md",
    ]) {
      await expect(readWiki(root, page)).rejects.toThrow(
        "factual Markdown page path",
      );
    }
    await writeFile(path.join(root, "outside.md"), "Outside wiki.");
    await symlink(
      path.join(root, "outside.md"),
      path.join(root, "openwiki/alias.md"),
    );
    await expect(readWiki(root, "alias.md")).rejects.toThrow("symbolic link");
    expect((await orientWiki(root)).pages.map(({ page }) => page)).toEqual([
      "quickstart.md",
    ]);
  });
});

describe("memory tools over MCP", () => {
  test("reads without a generation run and returns actionable errors without closing the transport", async () => {
    const state = await writeLinkedPage();
    const manager = HostSessionManager.create({ host: "codex" });
    const server = createOpenWikiMcpServer(manager);
    const client = new Client({ name: "memory-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const originalMarkdown = await readFile(
      path.join(root, "openwiki", PAGE),
      "utf8",
    );
    const originalSidecar = await readFile(
      path.join(root, "openwiki/.claims/concepts/jobs.json"),
      "utf8",
    );
    try {
      expect(
        (await client.listTools()).tools.map(({ name }) => name),
      ).toContain("openwiki_orient");
      for (const [name, args, expected] of [
        [
          "openwiki_read",
          { root, page: PAGE, sections: [state.sections[2].id] },
          await readWiki(root, PAGE, [state.sections[2].id]),
        ],
        [
          "openwiki_outline",
          { root, page: PAGE },
          await outlineWiki(root, PAGE),
        ],
        ["openwiki_orient", { root }, await orientWiki(root)],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent?.longTerm).toEqual(expected);
        expect(result.structuredContent?.shortTerm).toHaveProperty(
          "unavailable",
        );
        expect(result.structuredContent?.working).toHaveProperty("unavailable");
        expect(result.content).toEqual([
          { type: "text", text: JSON.stringify(result.structuredContent) },
        ]);
      }
      const unknown = await client.callTool({
        name: "openwiki_read",
        arguments: { root, page: PAGE, sections: ["missing"] },
      });
      expect(unknown.isError).toBe(true);
      expect(JSON.stringify(unknown.content)).toContain(
        "Call openwiki_outline",
      );
      const legacy = await client.callTool({
        name: "openwiki_outline",
        arguments: { root, page: "quickstart.md" },
      });
      expect(legacy.isError).toBe(true);
      expect(JSON.stringify(legacy.content)).toContain("OpenWiki update");
      await writeFile(
        path.join(root, "openwiki/.claims/concepts/jobs.json"),
        "private malformed data",
      );
      const corrupt = await client.callTool({
        name: "openwiki_read",
        arguments: { root, page: PAGE },
      });
      expect(corrupt.isError).toBe(true);
      expect(JSON.stringify(corrupt)).not.toContain("private malformed data");
      expect(JSON.stringify(corrupt)).toContain("invalid_state");
      await writeFile(
        path.join(root, "openwiki/.claims/concepts/jobs.json"),
        originalSidecar,
      );
      const recovered = await client.callTool({
        name: "openwiki_read",
        arguments: { root, page: PAGE },
      });
      expect(recovered.isError).not.toBe(true);
      expect(await readFile(path.join(root, "openwiki", PAGE), "utf8")).toBe(
        originalMarkdown,
      );
      expect(
        await readFile(
          path.join(root, "openwiki/.claims/concepts/jobs.json"),
          "utf8",
        ),
      ).toBe(originalSidecar);
      expect(await readdir(path.join(root, "openwiki"))).not.toContain(
        ".run.json",
      );
    } finally {
      await client.close();
      if (server.isConnected()) await server.close();
    }
  });
});
