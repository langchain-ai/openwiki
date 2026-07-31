import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import type { OpenWikiOnboardingConfig } from "../src/onboarding.ts";

// Mock external dependencies that ingestion.ts imports
vi.mock("../src/connectors/registry.js", () => ({
  createConnectorRegistry: vi.fn().mockReturnValue({
    "web-search": {
      id: "web-search",
      displayName: "Web Search",
      supportsAgenticDiscovery: false,
      ingest: vi.fn().mockResolvedValue({
        connectorId: "web-search",
        message: "ok",
        rawFiles: [],
        runId: "test",
        statePath: "/tmp/state",
        status: "success",
        warnings: [],
      }),
    },
    notion: {
      id: "notion",
      displayName: "Notion",
      supportsAgenticDiscovery: true,
      ingest: vi.fn(),
    },
  }),
  isConnectorId: vi.fn().mockReturnValue(true),
}));

vi.mock("../src/env.js", () => ({
  loadOpenWikiEnv: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/onboarding.js", () => ({
  readOpenWikiOnboardingConfig: vi.fn().mockResolvedValue({
    sourceInstances: [],
    sources: {},
    version: 1,
  }),
  saveOpenWikiOnboardingConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/openwiki-home.js", () => ({
  ensureOpenWikiHome: vi.fn().mockResolvedValue(undefined),
  getConnectorConfigPath: vi.fn().mockReturnValue("/tmp/config"),
  openWikiLocalWikiDir: "/tmp/wiki",
}));

vi.mock("../src/agent/index.js", () => ({
  createOpenWikiThreadId: vi.fn().mockReturnValue("test-thread-id"),
  runOpenWikiAgent: vi.fn().mockResolvedValue({
    command: "update",
    model: "test-model",
    output: "test output",
  }),
}));

// We need to test resolveIngestionSourceInstances which is a private function.
// Since it's called by runOpenWikiIngestion, we can test the behavior through
// the filtering logic by testing the source instance filtering directly.
// However, since the function is not exported, we test through the public API.

// Instead, we'll test the filtering logic by creating a direct test of the
// function's behavior through the runOpenWikiIngestion function with mocks.

// Actually, looking at the code more carefully, resolveIngestionSourceInstances
// is not exported. But we can test the behavior it implements by testing
// through the exported runOpenWikiIngestion function.

// However, a simpler approach: we can verify the filtering logic by
// directly testing the function's contract. Let me check if there's
// a way to test this.

// Since resolveIngestionSourceInstances is private, we'll test the
// behavior through the CLI dispatch and schedules modules which
// do test similar filtering. But the task specifically asks for
// ingestion-scheduling tests.

// Let me create a more focused test that tests the behavior
// by importing and testing the function indirectly.

// Actually, looking at the task spec again:
// - `resolveIngestionSourceInstances excludes source without schedule when scheduledOnly`
// - `resolveIngestionSourceInstances excludes source with paused schedule when scheduledOnly`
// - `resolveIngestionSourceInstances includes source with active schedule when scheduledOnly`

// Since this is a private function, we can test it by calling runOpenWikiIngestion
// with scheduledOnly: true and checking the results. But that requires mocking
// a lot of internals.

// A better approach: We can test the filtering behavior by directly testing
// the function. Let me check if we can use the internal module structure.

// Actually, looking at the code, resolveIngestionSourceInstances is defined
// as a module-level function in ingestion.ts. We can't directly import it.
// But we CAN test the behavior through the public API.

// Let me write tests that verify the behavior through runOpenWikiIngestion
// with appropriate mocks.

import { runOpenWikiIngestion } from "../src/ingestion.ts";

// Track calls to runOpenWikiAgent to verify which sources were processed
let processedSourceIds: string[] = [];

beforeEach(() => {
  processedSourceIds = [];
  vi.clearAllMocks();
});

describe("resolveIngestionSourceInstances — scheduledOnly filtering", () => {
  test("excludes source without schedule when scheduledOnly is true", async () => {
    // Arrange
    const { readOpenWikiOnboardingConfig } = await import(
      "../src/onboarding.js"
    );
    const { runOpenWikiAgent } = await import("../src/agent/index.js");

    vi.mocked(readOpenWikiOnboardingConfig).mockResolvedValue({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          // No schedule
        },
      ],
      sources: {},
      version: 1,
    });

    vi.mocked(runOpenWikiAgent).mockImplementation(
      async (_command, _cwd, options) => {
        processedSourceIds.push("should-not-reach-here");
        return {
          command: "update",
          model: "test-model",
          output: "test output",
        };
      },
    );

    // Act
    const result = await runOpenWikiIngestion("/tmp", {
      scheduledOnly: true,
      target: "all",
    });

    // Assert — no sources processed because the only source has no schedule
    expect(result.results).toHaveLength(0);
    expect(processedSourceIds).toHaveLength(0);
  });

  test("excludes source with paused schedule when scheduledOnly is true", async () => {
    // Arrange
    const { readOpenWikiOnboardingConfig } = await import(
      "../src/onboarding.js"
    );
    const { runOpenWikiAgent } = await import("../src/agent/index.js");

    vi.mocked(readOpenWikiOnboardingConfig).mockResolvedValue({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "daily",
            expression: "0 2 * * *",
            pausedAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
      sources: {},
      version: 1,
    });

    vi.mocked(runOpenWikiAgent).mockImplementation(
      async (_command, _cwd, options) => {
        processedSourceIds.push("should-not-reach-here");
        return {
          command: "update",
          model: "test-model",
          output: "test output",
        };
      },
    );

    // Act
    const result = await runOpenWikiIngestion("/tmp", {
      scheduledOnly: true,
      target: "all",
    });

    // Assert — source excluded because schedule is paused
    expect(result.results).toHaveLength(0);
    expect(processedSourceIds).toHaveLength(0);
  });

  test("includes source with active schedule when scheduledOnly is true", async () => {
    // Arrange
    const { readOpenWikiOnboardingConfig } = await import(
      "../src/onboarding.js"
    );
    const { runOpenWikiAgent } = await import("../src/agent/index.js");

    vi.mocked(readOpenWikiOnboardingConfig).mockResolvedValue({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "daily",
            expression: "0 2 * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
      sources: {},
      version: 1,
    });

    vi.mocked(runOpenWikiAgent).mockImplementation(
      async (_command, _cwd, options) => {
        return {
          command: "update",
          model: "test-model",
          output: "test output",
        };
      },
    );

    // Act
    const result = await runOpenWikiIngestion("/tmp", {
      scheduledOnly: true,
      target: "all",
    });

    // Assert — source included because schedule is active (no pausedAt)
    expect(result.results).toHaveLength(1);
    expect(result.results[0].sourceInstanceId).toBe("web-search-1");
  });

  test("excludes source without connectedAt regardless of schedule", async () => {
    // Arrange
    const { readOpenWikiOnboardingConfig } = await import(
      "../src/onboarding.js"
    );
    const { runOpenWikiAgent } = await import("../src/agent/index.js");

    vi.mocked(readOpenWikiOnboardingConfig).mockResolvedValue({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          // No connectedAt
          schedule: {
            description: "daily",
            expression: "0 2 * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
      sources: {},
      version: 1,
    });

    vi.mocked(runOpenWikiAgent).mockImplementation(
      async (_command, _cwd, options) => {
        processedSourceIds.push("should-not-reach-here");
        return {
          command: "update",
          model: "test-model",
          output: "test output",
        };
      },
    );

    // Act
    const result = await runOpenWikiIngestion("/tmp", {
      scheduledOnly: true,
      target: "all",
    });

    // Assert — source excluded because no connectedAt
    expect(result.results).toHaveLength(0);
    expect(processedSourceIds).toHaveLength(0);
  });

  test("when scheduledOnly is false, includes all connected sources", async () => {
    // Arrange
    const { readOpenWikiOnboardingConfig } = await import(
      "../src/onboarding.js"
    );
    const { runOpenWikiAgent } = await import("../src/agent/index.js");

    vi.mocked(readOpenWikiOnboardingConfig).mockResolvedValue({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          // No schedule
        },
        {
          connectorId: "notion",
          id: "notion-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "daily",
            expression: "0 2 * * *",
            pausedAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
      sources: {},
      version: 1,
    });

    vi.mocked(runOpenWikiAgent).mockImplementation(
      async (_command, _cwd, options) => {
        return {
          command: "update",
          model: "test-model",
          output: "test output",
        };
      },
    );

    // Act
    const result = await runOpenWikiIngestion("/tmp", {
      scheduledOnly: false,
      target: "all",
    });

    // Assert — both sources included when scheduledOnly is false
    expect(result.results).toHaveLength(2);
    expect(result.results[0].sourceInstanceId).toBe("web-search-1");
    expect(result.results[1].sourceInstanceId).toBe("notion-1");
  });
});
