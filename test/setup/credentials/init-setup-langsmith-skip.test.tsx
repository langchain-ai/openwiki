import React from "react";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { InitSetup } from "../../../src/setup/credentials.tsx";
import { getProviderApiKeyEnvKey } from "../../../src/config/constants.ts";
import { stripAnsi as plain } from "../../cli/components/ansi.ts";

// The wizard's config load and credential save touch ~/.openwiki. Stub the
// readers/writers so the state machine runs end to end without reading or
// writing real user state: an empty onboarding config forces the code tail to
// stop at code-repo-confirm, and the env writer is a no-op.
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

  return { ...actual, saveOpenWikiEnv: vi.fn(() => Promise.resolve()) };
});

/** Environment keys this suite drives; snapshotted and restored around each test. */
const MANAGED_KEYS = [
  "OPENWIKI_PROVIDER",
  "OPENWIKI_MODEL_ID",
  "ANTHROPIC_API_KEY",
  "LANGSMITH_API_KEY",
  "LANGCHAIN_TRACING_V2",
];

let snapshot: Record<string, string | undefined>;

/** Sets or clears a managed env key. */
function set(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  snapshot = {};
  for (const key of MANAGED_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    set(key, snapshot[key]);
  }
  vi.clearAllMocks();
});

/** Yields to microtasks and one macrotask so pending async work can settle. */
async function tick(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Polls the current frame until `predicate` holds, ticking between checks. The
 * mount's config-load effect resolves asynchronously (hydrateRunModeConfig does
 * real work), so a fixed delay is flaky; this waits only as long as needed.
 */
async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const frame = plain(lastFrame());
    if (predicate(frame)) {
      return frame;
    }
    await tick();
  }
  return plain(lastFrame());
}

/**
 * Puts the wizard at the model step for Anthropic: provider and key are present
 * so getInitialStep skips them, the model id is unset so the model step shows.
 * The caller sets the LangSmith signal before invoking.
 */
function seedProviderAndKey(): void {
  const apiKeyEnvKey = getProviderApiKeyEnvKey("anthropic");
  if (!apiKeyEnvKey) {
    throw new Error("anthropic must define an api key env var");
  }
  set("OPENWIKI_PROVIDER", "anthropic");
  set(apiKeyEnvKey, "sk-test");
  set("OPENWIKI_MODEL_ID", undefined);
}

/** The LangSmith prompt's distinctive body text (never shown on other steps). */
const LANGSMITH_PROMPT = "for tracing";

describe("InitSetup model step -> LangSmith routing (live state machine)", () => {
  test("skips LangSmith after the model when a tracing decision was recorded", async () => {
    seedProviderAndKey();
    // Recorded decline: LANGCHAIN_TRACING_V2 present means the optional step is
    // already answered, so a later pass must not re-prompt.
    set("LANGCHAIN_TRACING_V2", "false");

    const onComplete = vi.fn();
    const onError = vi.fn();
    const { stdin, lastFrame } = render(
      <InitSetup
        mode="code"
        allowModeSelection={false}
        walkAllSteps={false}
        onComplete={onComplete}
        onError={onError}
      />,
    );

    const modelFrame = await waitForFrame(lastFrame, (frame) =>
      frame.includes("Choose an"),
    );
    expect(modelFrame).toContain("Choose an");
    expect(modelFrame).not.toContain(LANGSMITH_PROMPT);

    // Enter selects the highlighted (default) model and advances.
    stdin.write("\r");
    // The model step must not route to LangSmith: wait for it to leave the model
    // prompt, then confirm the LangSmith prompt was skipped.
    const nextFrame = await waitForFrame(
      lastFrame,
      (frame) => !frame.includes("Choose an"),
    );
    expect(nextFrame).not.toContain(LANGSMITH_PROMPT);
    expect(onError).not.toHaveBeenCalled();
  });

  test("shows LangSmith after the model when no tracing decision exists", async () => {
    seedProviderAndKey();
    // Neither a key nor a recorded decision: the optional step is genuinely
    // unanswered, so the forward walk must still visit it.
    set("LANGSMITH_API_KEY", undefined);
    set("LANGCHAIN_TRACING_V2", undefined);

    const onComplete = vi.fn();
    const onError = vi.fn();
    const { stdin, lastFrame } = render(
      <InitSetup
        mode="code"
        allowModeSelection={false}
        walkAllSteps={false}
        onComplete={onComplete}
        onError={onError}
      />,
    );

    const modelFrame = await waitForFrame(lastFrame, (frame) =>
      frame.includes("Choose an"),
    );
    expect(modelFrame).toContain("Choose an");

    stdin.write("\r");
    const nextFrame = await waitForFrame(lastFrame, (frame) =>
      frame.includes(LANGSMITH_PROMPT),
    );
    expect(nextFrame).toContain(LANGSMITH_PROMPT);
    expect(onError).not.toHaveBeenCalled();
  });
});
