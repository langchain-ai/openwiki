import { describe, expect, test } from "vitest";

import { commandEmitsTelemetry, parseCommand } from "../src/commands.ts";

describe("commandEmitsTelemetry", () => {
  const emits = (argv: string[]): boolean =>
    commandEmitsTelemetry(parseCommand(argv));

  test("true only for init/update runs", () => {
    expect(emits(["personal", "--init"])).toBe(true);
    expect(emits(["personal", "--update"])).toBe(true);
  });

  test("false for chat, auth, ingest, help, error, cron, ngrok", () => {
    expect(emits(["personal"])).toBe(false); // chat (no init/update)
    expect(emits(["auth", "notion"])).toBe(false); // auth records nothing
    expect(emits(["ingest", "all"])).toBe(false); // ingest records nothing
    expect(emits(["--help"])).toBe(false); // help
    expect(emits(["personal", "--nope"])).toBe(false); // error: unknown option
    expect(emits(["cron", "list"])).toBe(false);
    expect(emits(["ngrok", "start"])).toBe(false);
  });

  test("false for a dry-run", () => {
    process.env.OPENWIKI_DEV = "1";
    try {
      expect(emits(["personal", "--init", "--dry-run"])).toBe(false);
    } finally {
      delete process.env.OPENWIKI_DEV;
    }
  });
});
