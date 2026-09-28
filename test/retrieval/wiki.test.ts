import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { UPDATE_METADATA_PATH } from "../../src/config/constants.ts";
import {
  readWikiSections,
  searchWiki,
  type WikiSearchResponse,
  type WikiSearchResults,
} from "../../src/retrieval/wiki.ts";
import {
  saveWikiWorkspaces,
  setActiveWikiWorkspace,
} from "../../src/linking/wiki-workspaces.ts";

/**
 * Temporary repository roots removed after each test.
 */
const temporaryRoots: string[] = [];

/**
 * Original workspace registry override restored after each test.
 */
const originalConfigDirectory = process.env.OPENWIKI_CONFIG_DIR;

/**
 * Inputs used to render one generated wiki-page fixture.
 */
interface WikiPageFixture {
  /**
   * Human-readable page title.
   */
  title: string;

  /**
   * Retrieval-oriented page description.
   */
  description: string;

  /**
   * Repository-relative source path placed in frontmatter.
   */
  source: string;

  /**
   * Authored Markdown below the page title.
   */
  body: string;
}

/**
 * Creates an isolated wiki root with an architecture directory.
 *
 * @returns Absolute temporary repository root.
 */
async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-retrieval-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "openwiki/architecture"), { recursive: true });
  return root;
}

/**
 * Creates one linkable repository wiki below a temporary workspace.
 *
 * @param workspace - Shared workspace root.
 * @param name - Repository directory and expected wiki ID.
 * @returns Absolute repository root.
 */
async function createLinkedRoot(
  workspace: string,
  name: string,
): Promise<string> {
  const root = path.join(workspace, name);
  await mkdir(path.join(root, ".git"), { recursive: true });
  await mkdir(path.join(root, "openwiki/architecture"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki/quickstart.md"),
    `# ${name} quickstart\n`,
    "utf8",
  );
  await writeFile(path.join(root, UPDATE_METADATA_PATH), "{}\n", "utf8");
  return root;
}

/**
 * Renders one complete OKF wiki-page fixture.
 *
 * @param options - Page metadata, source, and authored body.
 * @returns Complete Markdown page.
 */
function page(options: WikiPageFixture): string {
  return [
    "---",
    "type: guide",
    `title: ${options.title}`,
    `description: ${options.description}`,
    "sources:",
    "  - id: source",
    `    resource: repo://${options.source}`,
    "---",
    "",
    `# ${options.title}`,
    "",
    options.body,
    "",
  ].join("\n");
}

/**
 * Narrows one search response expected to contain ranked results.
 *
 * @param response - Search response under test.
 * @returns Successful ranked search response.
 */
function requireSearchResults(response: WikiSearchResponse): WikiSearchResults {
  if (!("results" in response)) {
    throw new Error("Expected a resolved wiki search scope.");
  }
  return response;
}

beforeEach(async () => {
  const configDirectory = await mkdtemp(
    path.join(os.tmpdir(), "openwiki-retrieval-config-"),
  );
  temporaryRoots.push(configDirectory);
  process.env.OPENWIKI_CONFIG_DIR = configDirectory;
});

afterEach(async () => {
  if (originalConfigDirectory === undefined) {
    delete process.env.OPENWIKI_CONFIG_DIR;
  } else {
    process.env.OPENWIKI_CONFIG_DIR = originalConfigDirectory;
  }
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("repository wiki retrieval", () => {
  test("search returns compact section references for progressive reads", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "openwiki/architecture/payments.md"),
      page({
        title: "Payment Runtime",
        description: "Payment execution, retries, and failure handling.",
        source: "src/payments/service.ts",
        body: [
          "Requests enter through the payment service.",
          "",
          "## Retry control",
          "",
          "The circuit breaker owns the retry budget and exponential backoff.",
          "",
          "This additional paragraph is intentionally absent from the compact search excerpt.",
          "",
          "## Settlement",
          "",
          "Successful authorizations are settled asynchronously.",
        ].join("\n"),
      }),
      "utf8",
    );

    const result = requireSearchResults(
      await searchWiki(root, {
        query: "Where is the retry budget and circuit breaker enforced?",
      }),
    );

    expect(result.results[0]).toMatchObject({
      kind: "section",
      ref: ["openwiki/architecture/payments.md#retry-control"],
    });
    expect(result.results[0]?.content).toContain("exponential backoff");
    expect(result.results[0]?.content).not.toContain("intentionally absent");
  });

  test("creates safe anchors from headings containing nested HTML", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "openwiki/architecture/anchors.md"),
      page({
        title: "Anchor Safety",
        description: "Heading anchor safety behavior.",
        source: "src/anchors.ts",
        body: [
          "## <em>Retry</em> <script<script>>control</script>",
          "",
          "The circuit breaker owns nested sanitization behavior.",
        ].join("\n"),
      }),
      "utf8",
    );

    const result = requireSearchResults(
      await searchWiki(root, { query: "nested sanitization circuit breaker" }),
    );
    const reference = result.results[0]?.ref[0];

    expect(reference).toMatch(
      /^openwiki\/architecture\/anchors\.md#[\p{L}\p{N}_-]+$/u,
    );
    expect(reference).not.toContain("<script");
  });

  test("source paths boost otherwise ambiguous matches", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "openwiki/architecture/api.md"),
      page({
        title: "API Validation",
        description: "Request validation.",
        source: "src/api/validate.ts",
        body: "## Validation\n\nValidation rejects malformed requests.",
      }),
      "utf8",
    );
    await writeFile(
      path.join(root, "openwiki/architecture/jobs.md"),
      page({
        title: "Job Validation",
        description: "Queued job validation.",
        source: "src/jobs/validate.ts",
        body: "## Validation\n\nValidation rejects malformed queued requests.",
      }),
      "utf8",
    );

    const result = requireSearchResults(
      await searchWiki(root, {
        query: "validation rejects malformed requests",
        paths: ["src/jobs/validate.ts"],
        limit: 1,
      }),
    );

    expect(result.results[0]?.ref).toEqual([
      "openwiki/architecture/jobs.md#validation",
    ]);
  });

  test("read returns exact complete sections in request order", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "openwiki/architecture/payments.md"),
      page({
        title: "Payment Runtime",
        description: "Payment behavior.",
        source: "src/payments.ts",
        body: [
          "## Retry control",
          "",
          "The first retry section.",
          "",
          "### Limits",
          "",
          "The child section stays with its parent.",
          "",
          "## Retry control",
          "",
          "The repeated retry section.",
        ].join("\n"),
      }),
      "utf8",
    );

    const result = await readWikiSections(root, {
      page: "openwiki/architecture/payments.md",
      sections: ["retry-control-1", "retry-control"],
    });

    expect(result.page).toBe("openwiki/architecture/payments.md");
    expect(result.sections).toEqual([
      {
        section: "retry-control-1",
        content: "## Retry control\n\nThe repeated retry section.",
      },
      {
        section: "retry-control",
        content: [
          "## Retry control",
          "",
          "The first retry section.",
          "",
          "### Limits",
          "",
          "The child section stays with its parent.",
        ].join("\n"),
      },
    ]);
  });

  test("linked search spans repositories and identifies results for exact reads", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "openwiki-retrieval-"),
    );
    temporaryRoots.push(workspace);
    const controlPlane = await createLinkedRoot(workspace, "control-plane");
    const dataPlane = await createLinkedRoot(workspace, "data-plane");
    await writeFile(
      path.join(controlPlane, "openwiki/architecture/routing.md"),
      page({
        title: "Control Plane Routing",
        description: "Desired route distribution and reconciliation.",
        source: "src/routes/reconciler.ts",
        body: "## Route publication\n\nThe control plane publishes signed route snapshots to every data-plane cell.",
      }),
      "utf8",
    );
    await writeFile(
      path.join(dataPlane, "openwiki/architecture/requests.md"),
      page({
        title: "Data Plane Requests",
        description: "Runtime request execution.",
        source: "src/runtime/request.ts",
        body: "## Request execution\n\nThe data plane applies the active route snapshot to each request.",
      }),
      "utf8",
    );
    await saveWikiWorkspaces([
      { name: "Payments", roots: [controlPlane, dataPlane] },
    ]);

    const search = requireSearchResults(
      await searchWiki(dataPlane, {
        query: "Who publishes signed route snapshots?",
      }),
    );

    expect(search).toMatchObject({
      workspace: { id: "payments", name: "Payments", wikiCount: 2 },
      wikis: [
        { id: "control-plane", name: "control-plane" },
        { id: "data-plane", name: "data-plane" },
      ],
    });
    expect(search.results[0]).toMatchObject({
      wiki: "control-plane",
      ref: ["openwiki/architecture/routing.md#route-publication"],
    });
    await expect(
      readWikiSections(dataPlane, {
        wiki: "control-plane",
        page: "openwiki/architecture/routing.md",
        sections: ["route-publication"],
      }),
    ).resolves.toEqual({
      wiki: "control-plane",
      page: "openwiki/architecture/routing.md",
      sections: [
        {
          section: "route-publication",
          content:
            "## Route publication\n\nThe control plane publishes signed route snapshots to every data-plane cell.",
        },
      ],
    });
  });

  test("linked reads default locally and reject undiscovered wiki identities", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "openwiki-retrieval-"),
    );
    temporaryRoots.push(workspace);
    const controlPlane = await createLinkedRoot(workspace, "control-plane");
    const dataPlane = await createLinkedRoot(workspace, "data-plane");
    await writeFile(
      path.join(dataPlane, "openwiki/architecture/runtime.md"),
      page({
        title: "Runtime",
        description: "Data-plane runtime.",
        source: "src/runtime.ts",
        body: "## Startup\n\nThe runtime verifies its route snapshot.",
      }),
      "utf8",
    );
    await saveWikiWorkspaces([
      { name: "Payments", roots: [controlPlane, dataPlane] },
    ]);

    await expect(
      readWikiSections(dataPlane, {
        page: "openwiki/architecture/runtime.md",
        sections: ["startup"],
      }),
    ).resolves.not.toHaveProperty("wiki");
    await expect(
      readWikiSections(dataPlane, {
        wiki: "unknown-service",
        page: "openwiki/architecture/runtime.md",
        sections: ["startup"],
      }),
    ).rejects.toThrow("Unknown wiki ID");
  });

  test("returns workspace choices until an overlap is active or explicit", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openwiki-retrieval-"),
    );
    temporaryRoots.push(directory);
    const shared = await createLinkedRoot(directory, "shared");
    const payments = await createLinkedRoot(directory, "payments");
    const platform = await createLinkedRoot(directory, "platform");
    await saveWikiWorkspaces([
      { name: "Payments", roots: [shared, payments] },
      { name: "Platform", roots: [shared, platform] },
    ]);

    await expect(
      searchWiki(shared, { query: "request routing" }),
    ).resolves.toEqual({
      status: "workspace_required",
      wiki: { id: "shared", name: "shared" },
      workspaces: [
        { id: "payments", name: "Payments", wikiCount: 2 },
        { id: "platform", name: "Platform", wikiCount: 2 },
      ],
    });

    await setActiveWikiWorkspace(shared, "platform");
    await expect(
      searchWiki(shared, { query: "request routing" }),
    ).resolves.toMatchObject({ workspace: { id: "platform" }, results: [] });
    await expect(
      searchWiki(shared, {
        query: "request routing",
        workspace: "Payments",
      }),
    ).resolves.toMatchObject({ workspace: { id: "payments" }, results: [] });
  });

  test("returns no search results when the repository has no wiki", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-retrieval-"));
    temporaryRoots.push(root);
    await expect(searchWiki(root, { query: "architecture" })).resolves.toEqual({
      results: [],
    });
  });

  test("ignores hidden and deprecated pages and treats FTS operators as data", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "openwiki/architecture/.private.md"),
      page({
        title: "Private",
        description: "Hidden internal notes.",
        source: "src/private.ts",
        body: "## Hidden\n\nhiddenonly",
      }),
      "utf8",
    );
    await writeFile(
      path.join(root, "openwiki/architecture/retired.md"),
      page({
        title: "Retired",
        description: "Deprecated notes.",
        source: "src/retired.ts",
        body: "## Retired\n\nretiredonly",
      }).replace("type: guide", "type: guide\nstatus: deprecated"),
      "utf8",
    );

    await expect(searchWiki(root, { query: "hiddenonly" })).resolves.toEqual({
      results: [],
    });
    await expect(searchWiki(root, { query: "retiredonly" })).resolves.toEqual({
      results: [],
    });
    await expect(searchWiki(root, { query: '" OR * NOT (' })).resolves.toEqual({
      results: [],
    });
    await expect(
      readWikiSections(root, {
        page: "openwiki/architecture/.private.md",
        sections: ["hidden"],
      }),
    ).rejects.toThrow("non-structural Markdown path");
  });

  test("read rejects structural pages and unknown sections", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "openwiki/index.md"), "# Index\n", "utf8");
    await writeFile(
      path.join(root, "openwiki/architecture/runtime.md"),
      page({
        title: "Runtime",
        description: "Runtime behavior.",
        source: "src/runtime.ts",
        body: "## Startup\n\nStartup validates configuration.",
      }),
      "utf8",
    );

    await expect(
      readWikiSections(root, {
        page: "openwiki/index.md",
        sections: ["index"],
      }),
    ).rejects.toThrow("non-structural Markdown path");
    await expect(
      readWikiSections(root, {
        page: "openwiki/architecture/runtime.md",
        sections: ["missing"],
      }),
    ).rejects.toThrow("Unknown section: missing");
  });
});
