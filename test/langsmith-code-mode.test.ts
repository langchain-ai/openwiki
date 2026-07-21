import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/connectors/sources/langsmith/index.ts", () => ({
  createLangSmithConnector: vi.fn(),
}));

vi.mock("../src/connectors/sources/langsmith/repo-config.ts", () => ({
  readLangSmithRepoConfig: vi.fn(),
}));

import { buildLangSmithCodeUpdateMessage } from "../src/connectors/sources/langsmith/code-mode.ts";
import { createLangSmithConnector } from "../src/connectors/sources/langsmith/index.ts";
import { readLangSmithRepoConfig } from "../src/connectors/sources/langsmith/repo-config.ts";
import type {
  ConnectorIngestOptions,
  ConnectorIngestResult,
} from "../src/connectors/types.ts";

const REPO_ROOT = "/repo";
const BASE = "Run the code-mode documentation update.";
const PROJECTS = ["support-bot-prod", "support-bot-staging"];

/**
 * Stubs one ingest result and returns the typed ingest spy for arg assertions.
 */
function mockConnector(result: ConnectorIngestResult) {
  const ingest =
    vi.fn<
      (options?: ConnectorIngestOptions) => Promise<ConnectorIngestResult>
    >();
  ingest.mockResolvedValue(result);
  vi.mocked(createLangSmithConnector).mockReturnValue({
    ingest,
  } as unknown as ReturnType<typeof createLangSmithConnector>);
  return ingest;
}

function successResult(
  overrides: Partial<ConnectorIngestResult> = {},
): ConnectorIngestResult {
  return {
    connectorId: "langsmith",
    message: "Pulled 2 of 2 LangSmith project(s).",
    rawFiles: ["/raw/langsmith/run-1/langsmith-results.json"],
    runId: "run-1",
    statePath: "~/.openwiki/connectors/langsmith/state.json",
    status: "success",
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildLangSmithCodeUpdateMessage", () => {
  test("returns the base message and never ingests when no config is present", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue(undefined);

    await expect(
      buildLangSmithCodeUpdateMessage(REPO_ROOT, BASE),
    ).resolves.toBe(BASE);
    expect(createLangSmithConnector).not.toHaveBeenCalled();
  });

  test("returns the base message when the config lists no projects", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue({ projects: [] });

    await expect(
      buildLangSmithCodeUpdateMessage(REPO_ROOT, BASE),
    ).resolves.toBe(BASE);
    expect(createLangSmithConnector).not.toHaveBeenCalled();
  });

  test("appends grounded, privacy-guarded guidance on a successful pull", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue({
      includeFeedback: true,
      projects: PROJECTS,
    });
    const ingest = mockConnector(successResult());

    const message = await buildLangSmithCodeUpdateMessage(REPO_ROOT, BASE);

    // The base message is preserved and the guidance is appended.
    expect(message?.startsWith(BASE)).toBe(true);
    for (const project of PROJECTS) {
      expect(message).toContain(project);
    }
    expect(message).toContain("openwiki_read_raw_item");
    expect(message).toContain("Never copy raw run inputs or outputs");

    // Privacy + intent are forced by the caller, not the repo file.
    expect(ingest.mock.calls[0]?.[0]?.connectorConfig).toMatchObject({
      enabled: true,
      includeFeedback: true,
      includePayloads: false,
      projects: PROJECTS,
    });
  });

  test("returns just the guidance when there is no base message", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue({
      projects: PROJECTS,
    });
    mockConnector(successResult());

    const message = await buildLangSmithCodeUpdateMessage(REPO_ROOT, undefined);

    expect(message).toContain("LangSmith runtime evidence is available");
    expect(message?.startsWith("LangSmith runtime evidence")).toBe(true);
  });

  test("surfaces connector warnings in the guidance", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue({
      projects: PROJECTS,
    });
    mockConnector(
      successResult({
        warnings: ["support-bot-staging: hit the per-run fetch limit"],
      }),
    );

    const message = await buildLangSmithCodeUpdateMessage(REPO_ROOT, BASE);

    expect(message).toContain("Connector warnings:");
    expect(message).toContain(
      "support-bot-staging: hit the per-run fetch limit",
    );
  });

  test.each([
    ["skipped", { status: "skipped", rawFiles: [] }],
    ["error", { status: "error", rawFiles: [] }],
    ["success but empty", { status: "success", rawFiles: [] }],
  ])(
    "returns the base message unchanged when the pull is %s (noop preserved)",
    async (_label, overrides) => {
      vi.mocked(readLangSmithRepoConfig).mockResolvedValue({
        projects: PROJECTS,
      });
      mockConnector(successResult(overrides));

      await expect(
        buildLangSmithCodeUpdateMessage(REPO_ROOT, BASE),
      ).resolves.toBe(BASE);
    },
  );
});
