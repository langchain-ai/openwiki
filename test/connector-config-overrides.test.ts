import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

// The gmail, slack, and x connectors read their on-disk config from
// `~/.openwiki/connectors/<id>/config.json` (a path derived from
// `os.homedir()`, which honors $HOME). These tests point $HOME at a throwaway
// temp dir and write a config file there, so we can assert that per-instance
// `options.connectorConfig` overrides are merged on top of the on-disk config
// — the bug this PR fixes, where gmail/slack/x silently ignored the overrides.
//
// Each connector short-circuits before any network call:
//   1. an `enabled` gate  -> returns status "skipped" when disabled
//   2. a credentials gate -> returns status "error"   when the token env is unset
// so the observable effect of the merge is which gate the run stops at, with no
// `fetch` involved.

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

const CONNECTOR_ENV_KEYS = [
  "OPENWIKI_X_ACCESS_TOKEN",
  "OPENWIKI_SLACK_USER_TOKEN",
] as const;
const savedEnv: Record<string, string | undefined> = {};

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-connector-config-"));
  tempHomes.push(home);
  return home;
}

async function writeConnectorConfig(
  home: string,
  connectorId: string,
  config: unknown,
): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", connectorId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

afterEach(async () => {
  vi.resetModules();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  for (const key of CONNECTOR_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

function clearConnectorTokens(): void {
  for (const key of CONNECTOR_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

async function loadXConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  clearConnectorTokens();
  const { createXConnector } = await import("../src/connectors/sources/x.ts");
  return createXConnector();
}

async function loadSlackConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  clearConnectorTokens();
  const { createSlackConnector } =
    await import("../src/connectors/sources/slack.ts");
  return createSlackConnector();
}

async function loadGmailConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  clearConnectorTokens();
  const { createGmailConnector } =
    await import("../src/connectors/sources/gmail.ts");
  return createGmailConnector();
}

describe("x connector honors options.connectorConfig", () => {
  test("skips when on-disk config is disabled and no override is given", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "x", { enabled: false });
    const connector = await loadXConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
  });

  test("override enabled=true moves past the enabled gate to the token gate", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "x", { enabled: false });
    const connector = await loadXConnector(home);

    const result = await connector.ingest({
      connectorConfig: { enabled: true },
    });

    // Merge honored: enabled gate passed, so it stops at the missing-token gate.
    // If the override were ignored (the bug), status would still be "skipped".
    expect(result.status).toBe("error");
    expect(result.message).toContain("OPENWIKI_X_ACCESS_TOKEN");
  });
});

describe("slack connector honors options.connectorConfig", () => {
  test("skips when on-disk config is disabled and no override is given", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "slack", { enabled: false });
    const connector = await loadSlackConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
  });

  test("override enabled=true moves past the enabled gate to the token gate", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "slack", { enabled: false });
    const connector = await loadSlackConnector(home);

    const result = await connector.ingest({
      connectorConfig: { enabled: true },
    });

    expect(result.status).toBe("error");
    expect(result.message).toContain("OPENWIKI_SLACK_USER_TOKEN");
  });
});

describe("gmail connector honors options.connectorConfig", () => {
  test("override enabled=false skips even though on-disk config is enabled", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "google", { enabled: true });
    const connector = await loadGmailConnector(home);

    const result = await connector.ingest({
      connectorConfig: { enabled: false },
    });

    // Merge honored: the override disables the run before any Gmail API call.
    // If the override were ignored (the bug), it would proceed past this gate.
    expect(result.status).toBe("skipped");
  });
});
