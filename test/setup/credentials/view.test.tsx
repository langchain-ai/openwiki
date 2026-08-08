import React from "react";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  InitSetupView,
  type InitSetupViewProps,
} from "../../../src/setup/credentials/view.tsx";
import { createEmptyOnboardingConfig } from "../../../src/setup/onboarding.ts";
import {
  getSourceOption,
  getTemplateSourceOptions,
} from "../../../src/setup/credentials/steps.ts";
import { stripAnsi as plain } from "../../cli/components/ansi.ts";

/** Renders the view and returns its ANSI-stripped final frame. */
function frameOf(props: InitSetupViewProps): string {
  return plain(render(<InitSetupView {...props} />).lastFrame());
}

/**
 * Builds a full, valid props bag with sane defaults. Individual tests override
 * only the fields they exercise so the render is always fully typed.
 */
function makeProps(
  overrides: Partial<InitSetupViewProps> = {},
): InitSetupViewProps {
  return {
    allowModeSelection: false,
    step: "provider",
    selectedMode: "personal",
    provider: "anthropic",
    providerConfirmed: false,
    apiKey: null,
    oauthTokens: null,
    secretKey: null,
    gcpProject: null,
    gcpLocation: null,
    baseUrl: null,
    region: null,
    modelId: null,
    modelIdOverride: null,
    langSmithKey: null,
    onboardingConfig: createEmptyOnboardingConfig(),
    copied: false,
    input: "",
    isLoggingIn: false,
    loginUrl: null,
    codeRepoPathInput: "",
    codeRepoRoot: "/tmp/repo",
    externalCliAuth: { kind: "idle" },
    codeRepoSelectionIndex: 0,
    cronFieldSelectionIndex: 0,
    cronModeSelectionIndex: 0,
    finalSelectionIndex: 0,
    isCustomModelInput: false,
    langsmithDraft: null,
    langsmithRegionSelectionIndex: 0,
    langsmithWorkspaceSelectionIndex: 0,
    langsmithWorkspaces: [],
    modelSelectionIndex: 0,
    powerModeSelectionIndex: 0,
    providerSelectionIndex: 0,
    runModeSelectionIndex: 0,
    secretInputIndex: 0,
    sourceContinueSelectionIndex: 0,
    sourceDescriptionSelectionIndex: 0,
    sourceSelectionIndex: 0,
    sourceState: { secretValues: {} },
    templateSelectionIndex: 0,
    notice: null,
    error: null,
    isSaving: false,
    isAuthRunning: false,
    activeSourceOptions: getTemplateSourceOptions(undefined),
    selectedSource: getSourceOption("git-repo"),
    suggestedCronExpression: "0 2 * * *",
    suggestedCronDescription: "At 02:00",
    inputDisplayWidth: 64,
    navHistoryLength: 0,
    ...overrides,
  };
}

describe("InitSetupView", () => {
  const originalLangSmithKey = process.env.LANGSMITH_API_KEY;

  beforeEach(() => {
    delete process.env.LANGSMITH_API_KEY;
  });

  afterEach(() => {
    if (originalLangSmithKey === undefined) {
      delete process.env.LANGSMITH_API_KEY;
    } else {
      process.env.LANGSMITH_API_KEY = originalLangSmithKey;
    }
  });

  test("renders the header and provider/model summary rows", () => {
    const frame = frameOf(makeProps({ provider: "anthropic" }));
    expect(frame).toContain("OpenWiki");
    expect(frame).toContain("first-run setup");
    expect(frame).toContain("Provider");
    expect(frame).toContain("Model");
  });

  test("renders the OAuthLoginPrompt branch for the oauth-login step", () => {
    const frame = frameOf(
      makeProps({
        step: "oauth-login",
        provider: "openai-chatgpt",
        loginUrl: "https://auth.example/login",
      }),
    );
    expect(frame).toContain("ChatGPT login");
    expect(frame).toContain("https://auth.example/login");
  });

  test("renders the Prompt panel for a non-oauth step", () => {
    const frame = frameOf(makeProps({ step: "provider" }));
    expect(frame).toContain("Prompt");
    expect(frame).toContain("Choose a model provider.");
  });

  test("shows the status and error panels when those props are set", () => {
    const frame = frameOf(
      makeProps({ notice: "Heads up notice", error: "Something broke" }),
    );
    expect(frame).toContain("Status");
    expect(frame).toContain("Heads up notice");
    expect(frame).toContain("Error");
    expect(frame).toContain("Something broke");
  });

  test("shows the inspecting placeholder and saving panel when applicable", () => {
    const frame = frameOf(makeProps({ step: null, isSaving: true }));
    expect(frame).toContain("Inspecting OpenWiki setup...");
    expect(frame).toContain("Saving");
    expect(frame).toContain("Writing OpenWiki setup...");
  });
});
