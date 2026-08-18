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
  const originalTracing = process.env.LANGCHAIN_TRACING_V2;

  beforeEach(() => {
    delete process.env.LANGSMITH_API_KEY;
    delete process.env.LANGCHAIN_TRACING_V2;
  });

  afterEach(() => {
    if (originalLangSmithKey === undefined) {
      delete process.env.LANGSMITH_API_KEY;
    } else {
      process.env.LANGSMITH_API_KEY = originalLangSmithKey;
    }
    if (originalTracing === undefined) {
      delete process.env.LANGCHAIN_TRACING_V2;
    } else {
      process.env.LANGCHAIN_TRACING_V2 = originalTracing;
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

  test("code mode surfaces the wiki-scope row in the detected section", () => {
    const frame = frameOf(
      makeProps({ selectedMode: "code", step: "provider" }),
    );
    expect(frame).toContain("Wiki scope");
    expect(frame).toContain("openwiki/");
  });

  test("mode selection marks the run-mode row current on its step", () => {
    const frame = frameOf(
      makeProps({ allowModeSelection: true, step: "run-mode" }),
    );
    expect(frame).toContain("Run mode");
  });

  test("an AWS SDK provider renders the AWS credentials and region rows", () => {
    const frame = frameOf(
      makeProps({ provider: "bedrock", step: "region", region: "us-west-2" }),
    );
    expect(frame).toContain("AWS credentials");
    expect(frame).toContain("Region");
    expect(frame).toContain("us-west-2");
  });

  test("an OAuth provider renders the ChatGPT login row", () => {
    const frame = frameOf(
      makeProps({
        provider: "openai-chatgpt",
        step: "provider",
        oauthTokens: {
          access: "a",
          refresh: "r",
          expiresAtMs: 1,
          accountId: "acct",
          email: "me@example.com",
          planType: "pro",
        },
      }),
    );
    expect(frame).toContain("ChatGPT login");
  });

  test("a Vertex provider renders GCP project and location with entered values", () => {
    const frame = frameOf(
      makeProps({
        provider: "gemini-enterprise",
        step: "gcp-project",
        gcpProject: "proj-1",
        gcpLocation: "us-central1",
      }),
    );
    expect(frame).toContain("GCP project");
    expect(frame).toContain("proj-1");
    expect(frame).toContain("GCP location");
    expect(frame).toContain("us-central1");
  });

  test("an OpenAI-compatible provider renders the base URL row", () => {
    const frame = frameOf(
      makeProps({
        provider: "openai-compatible",
        step: "base-url",
        baseUrl: "https://api.local/v1",
      }),
    );
    expect(frame).toContain("Base URL");
    expect(frame).toContain("https://api.local/v1");
  });

  test("an API key entered this session marks the provider key configured", () => {
    const frame = frameOf(
      makeProps({ provider: "openai", step: "model", apiKey: "sk-123" }),
    );
    expect(frame).toContain("Provider key");
    expect(frame).toContain("configured");
  });

  test("a blank LangSmith key entered this session reads as skipped", () => {
    const frame = frameOf(makeProps({ langSmithKey: "" }));
    expect(frame).toContain("LangSmith");
    expect(frame).toContain("skipped");
  });

  test("a LangSmith key entered this session is not marked skipped", () => {
    const frame = frameOf(makeProps({ langSmithKey: "ls-key" }));
    expect(frame).toContain("LangSmith");
    expect(frame).not.toContain("skipped");
  });

  test("a saved LangSmith key in the environment renders without a skip label", () => {
    process.env.LANGSMITH_API_KEY = "ls-env";
    const frame = frameOf(makeProps({ langSmithKey: null }));
    expect(frame).toContain("LangSmith");
    expect(frame).not.toContain("skipped");
  });

  test("a recorded tracing decline (no key, no session value) reads as skipped", () => {
    process.env.LANGCHAIN_TRACING_V2 = "false";
    // Only the LangSmith row ever emits "skipped", so its presence proves the
    // declined-via-env state no longer reads as the "not set" resting label.
    const frame = frameOf(makeProps({ langSmithKey: null }));
    expect(frame).toContain("LangSmith");
    expect(frame).toContain("skipped");
  });

  test("an entered model id is shown as the model detail", () => {
    const frame = frameOf(
      makeProps({ modelId: "claude-custom", step: "model" }),
    );
    expect(frame).toContain("claude-custom");
  });

  test("shows the reasoning effort step only for a supported model", () => {
    const supported = frameOf(
      makeProps({
        modelId: "gpt-5.6-luna",
        provider: "openai",
        reasoningEffort: "max",
        step: "reasoning-effort",
      }),
    );
    expect(supported).toContain("Reasoning effort");
    expect(supported).toContain("max");
    expect(supported).toContain("Provider default");

    const unsupported = frameOf(
      makeProps({ modelId: "gpt-5.5", provider: "openai", step: "model" }),
    );
    expect(unsupported).not.toContain("Reasoning effort");
  });

  test("a non-empty back history shows the go-back hint", () => {
    const frame = frameOf(makeProps({ navHistoryLength: 2 }));
    expect(frame).toContain("esc to go back");
  });

  test("a saved-schedule warning renders the schedule-note panel", () => {
    const frame = frameOf(
      makeProps({
        sourceState: { secretValues: {}, savedScheduleWarning: "cron drift" },
      }),
    );
    expect(frame).toContain("Schedule note");
    expect(frame).toContain("cron drift");
  });

  test("the authorization panel shows while awaiting the browser callback", () => {
    const frame = frameOf(makeProps({ isAuthRunning: true }));
    expect(frame).toContain("Authorization");
    expect(frame).toContain("Waiting for the browser authorization callback");
  });

  test("personal mode marks the schedule row current on a schedule step", () => {
    const frame = frameOf(
      makeProps({ selectedMode: "personal", step: "global-cron-mode" }),
    );
    expect(frame).toContain("Schedule");
  });

  test("personal mode marks the sources row current on a source step", () => {
    const frame = frameOf(
      makeProps({ selectedMode: "personal", step: "source-menu" }),
    );
    expect(frame).toContain("Sources");
  });

  test("personal mode surfaces wiki-scope, schedule, and sources as done", () => {
    const config = {
      ...createEmptyOnboardingConfig(),
      wikiGoal: "document the repo",
      ingestionSchedule: {
        description: "At 02:00",
        expression: "0 2 * * *",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      sourceInstances: [{ connectorId: "git-repo" as const, id: "git-repo:1" }],
    };
    const frame = frameOf(
      makeProps({
        selectedMode: "personal",
        step: "final",
        onboardingConfig: config,
        activeSourceOptions: [getSourceOption("git-repo")],
      }),
    );
    expect(frame).toContain("Schedule");
    expect(frame).toContain("At 02:00");
    expect(frame).toContain("Sources");
    expect(frame).toContain("1 configured");
  });
});
