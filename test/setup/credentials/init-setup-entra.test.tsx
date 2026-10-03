import React from "react";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { InitSetup } from "../../../src/setup/credentials.tsx";
import { stripAnsi as plain } from "../../cli/components/ansi.ts";

vi.mock("../../../src/setup/onboarding.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/setup/onboarding.ts")>();

  return {
    ...actual,
    readOpenWikiOnboardingConfig: vi.fn(() =>
      Promise.resolve(actual.createEmptyOnboardingConfig()),
    ),
    saveOpenWikiOnboardingConfig: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("../../../src/config/env.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/config/env.ts")>();
  return {
    ...actual,
    getSavedEnvValue: vi.fn((key: string) =>
      key === "OPENAI_COMPATIBLE_BASE_URL"
        ? "https://gateway.example.com/openai/v1"
        : undefined,
    ),
    saveOpenWikiEnv: vi.fn(() => Promise.resolve()),
  };
});

const MANAGED_KEYS = [
  "OPENWIKI_PROVIDER",
  "OPENWIKI_MODEL_ID",
  "OPENAI_COMPATIBLE_AUTH",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_ENTRA_SCOPE",
];

let snapshot: Record<string, string | undefined>;

beforeEach(() => {
  snapshot = {};
  for (const key of MANAGED_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OPENWIKI_PROVIDER = "openai-compatible";
  process.env.OPENAI_COMPATIBLE_AUTH = "entra-id";
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
});

/**
 * Wait for an asynchronous wizard transition without depending on a fixed delay.
 */
async function waitForFrame(
  lastFrame: () => string | undefined,
  text: string,
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const frame = plain(lastFrame());
    if (frame.includes(text)) {
      return frame;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return plain(lastFrame());
}

describe("InitSetup Entra selection", () => {
  test("walks through Entra base URL and scope without requesting a key", async () => {
    const onError = vi.fn();
    const { stdin, lastFrame } = render(
      <InitSetup
        mode="code"
        walkAllSteps
        onComplete={vi.fn()}
        onError={onError}
      />,
    );

    expect(await waitForFrame(lastFrame, "Choose a model provider.")).toContain(
      "OpenAI-compatible",
    );
    stdin.write("\r");
    expect(
      await waitForFrame(lastFrame, "Choose how the OpenAI-compatible gateway"),
    ).toContain("Microsoft Entra ID");

    await new Promise((resolve) => setTimeout(resolve, 0));
    stdin.write("\r");
    const baseUrlFrame = await waitForFrame(lastFrame, "HTTPS API root");
    expect(baseUrlFrame).toContain("OPENAI_COMPATIBLE_BASE_URL");
    expect(baseUrlFrame).toContain("https://gateway.example.com/openai/v1");
    expect(baseUrlFrame).not.toContain("Paste your");

    await new Promise((resolve) => setTimeout(resolve, 0));
    stdin.write("\r");
    const scopeFrame = await waitForFrame(
      lastFrame,
      "Enter the Entra token scope",
    );
    expect(scopeFrame).toContain("OPENAI_COMPATIBLE_ENTRA_SCOPE");
    expect(scopeFrame).not.toContain("Paste your");
    expect(onError).not.toHaveBeenCalled();
  });
});
