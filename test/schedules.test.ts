import { describe, expect, test, vi, beforeEach } from "vitest";
import type { OpenWikiOnboardingConfig } from "../src/onboarding.ts";

// Mock fs and child_process modules used by schedules.ts
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  access: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:util", () => ({
  promisify: vi.fn((fn: unknown) => fn),
}));

vi.mock("../src/openwiki-home.js", () => ({
  ensureOpenWikiHome: vi.fn().mockResolvedValue(undefined),
  openWikiHomeDir: "/tmp/openwiki-test",
}));

// Mock platform to non-darwin to skip launchd operations
const originalPlatform = process.platform;

beforeEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

import {
  listConnectorSchedules,
  pauseConnectorSchedules,
  resumeConnectorSchedules,
  deleteConnectorSchedules,
} from "../src/schedules.ts";
import { afterEach } from "vitest";

function makeConfig(
  overrides: Partial<OpenWikiOnboardingConfig> = {},
): OpenWikiOnboardingConfig {
  return {
    sourceInstances: [],
    sources: {},
    version: 1,
    ...overrides,
  };
}

describe("listConnectorSchedules", () => {
  test("returns one entry per sourceInstance with a schedule", async () => {
    // Arrange
    const config = makeConfig({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every day at 2am",
            expression: "0 2 * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        {
          connectorId: "notion",
          id: "notion-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every hour",
            expression: "0 * * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    });

    // Act
    const result = await listConnectorSchedules(config);

    // Assert
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      connectorId: "web-search",
      sourceInstanceId: "web-search-1",
      expression: "0 2 * * *",
      description: "Every day at 2am",
    });
    expect(result[1]).toMatchObject({
      connectorId: "notion",
      sourceInstanceId: "notion-1",
      expression: "0 * * * *",
      description: "Every hour",
    });
  });

  test("returns empty when no schedules exist", async () => {
    // Arrange
    const config = makeConfig({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    // Act
    const result = await listConnectorSchedules(config);

    // Assert
    expect(result).toHaveLength(0);
  });

  test("skips source instances without schedules", async () => {
    // Arrange
    const config = makeConfig({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          connectorId: "notion",
          id: "notion-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every hour",
            expression: "0 * * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    });

    // Act
    const result = await listConnectorSchedules(config);

    // Assert
    expect(result).toHaveLength(1);
    expect(result[0].sourceInstanceId).toBe("notion-1");
  });
});

describe("pauseConnectorSchedules", () => {
  test("with target 'all' pauses all source instances with schedules", async () => {
    // Arrange
    const config = makeConfig({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every day at 2am",
            expression: "0 2 * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        {
          connectorId: "notion",
          id: "notion-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every hour",
            expression: "0 * * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    });

    // Act
    const result = await pauseConnectorSchedules(config, "all");

    // Assert
    expect(result.connectorIds).toContain("web-search-1");
    expect(result.connectorIds).toContain("notion-1");
    expect(result.config.sourceInstances[0].schedule?.pausedAt).toBeDefined();
    expect(result.config.sourceInstances[1].schedule?.pausedAt).toBeDefined();
  });

  test("with a connector ID pauses matching instances", async () => {
    // Arrange
    const config = makeConfig({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every day at 2am",
            expression: "0 2 * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        {
          connectorId: "notion",
          id: "notion-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every hour",
            expression: "0 * * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    });

    // Act
    const result = await pauseConnectorSchedules(config, "web-search");

    // Assert
    expect(result.connectorIds).toEqual(["web-search-1"]);
    expect(result.config.sourceInstances[0].schedule?.pausedAt).toBeDefined();
    // Notion instance should remain unpaused
    expect(result.config.sourceInstances[1].schedule?.pausedAt).toBeUndefined();
  });

  test("with a source instance ID pauses that specific instance", async () => {
    // Arrange
    const config = makeConfig({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every day at 2am",
            expression: "0 2 * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        {
          connectorId: "web-search",
          id: "web-search-2",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every day at 3am",
            expression: "0 3 * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    });

    // Act
    const result = await pauseConnectorSchedules(config, {
      kind: "source-instance",
      id: "web-search-2",
    });

    // Assert
    expect(result.connectorIds).toEqual(["web-search-2"]);
    expect(result.config.sourceInstances[0].schedule?.pausedAt).toBeUndefined();
    expect(result.config.sourceInstances[1].schedule?.pausedAt).toBeDefined();
  });

  test("skips already-paused instances", async () => {
    // Arrange
    const config = makeConfig({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every day at 2am",
            expression: "0 2 * * *",
            pausedAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    });

    // Act
    const result = await pauseConnectorSchedules(config, "all");

    // Assert
    expect(result.connectorIds).toHaveLength(0);
    expect(result.skippedConnectorIds).toContain("web-search-1");
  });
});

describe("resumeConnectorSchedules", () => {
  test("resumes paused instances", async () => {
    // Arrange
    const config = makeConfig({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every day at 2am",
            expression: "0 2 * * *",
            pausedAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    });

    // Act
    const result = await resumeConnectorSchedules({
      config,
      cwd: "/tmp",
      target: "all",
    });

    // Assert
    expect(result.connectorIds).toContain("web-search-1");
    // The pausedAt should be cleared (schedule exists with expression but no pausedAt)
    const resumedSchedule = result.config.sourceInstances[0].schedule;
    expect(resumedSchedule).toBeDefined();
    expect(resumedSchedule?.pausedAt).toBeUndefined();
  });

  test("skips already-active instances", async () => {
    // Arrange
    const config = makeConfig({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every day at 2am",
            expression: "0 2 * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    });

    // Act
    const result = await resumeConnectorSchedules({
      config,
      cwd: "/tmp",
      target: "all",
    });

    // Assert
    expect(result.connectorIds).toHaveLength(0);
    expect(result.skippedConnectorIds).toContain("web-search-1");
  });
});

describe("deleteConnectorSchedules", () => {
  test("removes schedule from instances", async () => {
    // Arrange
    const config = makeConfig({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every day at 2am",
            expression: "0 2 * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    });

    // Act
    const result = await deleteConnectorSchedules(config, "all");

    // Assert
    expect(result.connectorIds).toContain("web-search-1");
    expect(result.config.sourceInstances[0].schedule).toBeUndefined();
  });

  test("skips instances without schedules", async () => {
    // Arrange
    const config = makeConfig({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    // Act
    const result = await deleteConnectorSchedules(config, "all");

    // Assert
    expect(result.connectorIds).toHaveLength(0);
    expect(result.skippedConnectorIds).toContain("web-search-1");
  });

  test("with connector ID only deletes matching instances", async () => {
    // Arrange
    const config = makeConfig({
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every day at 2am",
            expression: "0 2 * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        {
          connectorId: "notion",
          id: "notion-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule: {
            description: "Every hour",
            expression: "0 * * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    });

    // Act
    const result = await deleteConnectorSchedules(config, "web-search");

    // Assert
    expect(result.connectorIds).toEqual(["web-search-1"]);
    expect(result.config.sourceInstances[0].schedule).toBeUndefined();
    expect(result.config.sourceInstances[1].schedule).toBeDefined();
  });
});
