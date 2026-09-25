import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, test } from "vitest";

import { STEP_GLYPH } from "../../../src/setup/credentials/constants.ts";
import {
  BorderedInput,
  BorderedMultilineInput,
  ExternalCliAuthPrompt,
  InputValueWithCursor,
  OAuthAuthorizationLink,
  OAuthLoginPrompt,
  Prompt,
  SegmentedCronInput,
  SelectionMarker,
  SetupHeader,
  SetupPanel,
  SetupStep,
  SourceConnectionStatus,
} from "../../../src/setup/credentials/components.tsx";
import {
  getSourceOption,
  getTemplateSourceOptions,
} from "../../../src/setup/credentials/steps.ts";
import { createEmptyOnboardingConfig } from "../../../src/setup/onboarding.ts";
import { stripAnsi as plain } from "../../cli/components/ansi.ts";

/** Renders a component and returns its ANSI-stripped final frame. */
function frameOf(element: React.ReactElement): string {
  return plain(render(element).lastFrame());
}

describe("SetupHeader", () => {
  test("labels the first-run setup and its purpose", () => {
    const frame = frameOf(<SetupHeader />);
    expect(frame).toContain("OpenWiki");
    expect(frame).toContain("first-run setup");
    expect(frame).toContain("Configure the model, wiki scope, and sources.");
  });
});

describe("SetupStep", () => {
  test("renders the state glyph, padded label, and detail", () => {
    const frame = frameOf(
      <SetupStep detail="default sonnet" label="Model" state="current" />,
    );
    expect(frame).toContain(STEP_GLYPH.current);
    expect(frame).toContain("Model");
    expect(frame).toContain("default sonnet");
  });
});

describe("SetupPanel", () => {
  test("renders its title above the children", () => {
    const frame = frameOf(
      <SetupPanel title="Provider">
        <SetupStep detail="" label="Anthropic" state="pending" />
      </SetupPanel>,
    );
    expect(frame).toContain("Provider");
    expect(frame).toContain("Anthropic");
  });
});

describe("SelectionMarker", () => {
  test("shows a caret only when selected", () => {
    expect(frameOf(<SelectionMarker isSelected />)).toContain(">");
    expect(frameOf(<SelectionMarker isSelected={false} />)).not.toContain(">");
  });
});

describe("SourceConnectionStatus", () => {
  test("reports configured, plural counts, and unconfigured", () => {
    expect(
      frameOf(<SourceConnectionStatus count={1} isConfigured />),
    ).toContain("[configured]");
    expect(
      frameOf(<SourceConnectionStatus count={3} isConfigured />),
    ).toContain("[configured x3]");
    expect(
      frameOf(<SourceConnectionStatus count={0} isConfigured={false} />),
    ).toContain("[not configured]");
  });
});

describe("OAuthAuthorizationLink", () => {
  test("renders the link label and the copied-to-clipboard status", () => {
    const frame = frameOf(
      <OAuthAuthorizationLink
        authProvider="notion"
        copiedToClipboard
        url="https://auth.example/authorize"
      />,
    );
    expect(frame).toContain("Open authorization URL");
    expect(frame).toContain("copied to clipboard");
  });
});

describe("OAuthLoginPrompt", () => {
  test("surfaces the login url and copy hint once a url is available", () => {
    const frame = frameOf(
      <OAuthLoginPrompt
        copied={false}
        input=""
        isLoggingIn
        loginUrl="https://chatgpt.example/device"
        provider="openai-chatgpt"
      />,
    );
    expect(frame).toContain("https://chatgpt.example/device");
    expect(frame).toContain("to copy the URL");
    expect(frame).toContain("Waiting for browser sign-in");
  });

  test("shows the starting message before a url exists", () => {
    const frame = frameOf(
      <OAuthLoginPrompt
        copied={false}
        input=""
        isLoggingIn
        loginUrl={null}
        provider="openai-chatgpt"
      />,
    );
    expect(frame).toContain("Starting the ChatGPT login");
  });
});

describe("InputValueWithCursor", () => {
  test("shows plain text as entered", () => {
    expect(
      frameOf(<InputValueWithCursor maxDisplayWidth={40} value="hello" />),
    ).toContain("hello");
  });

  test("masks a secret to bullets and never leaks the raw value", () => {
    const frame = frameOf(
      <InputValueWithCursor maxDisplayWidth={40} secret value="sk-topsecret" />,
    );
    expect(frame).not.toContain("sk-topsecret");
    expect(frame).toContain("•");
  });
});

describe("BorderedInput", () => {
  test("renders the value with a shell-style prefix when given one", () => {
    const frame = frameOf(
      <BorderedInput
        maxDisplayWidth={40}
        prefix="OPENAI_API_KEY"
        value="abc"
      />,
    );
    expect(frame).toContain("OPENAI_API_KEY");
    expect(frame).toContain("abc");
  });
});

describe("BorderedMultilineInput", () => {
  test("renders the multi-line value", () => {
    expect(
      frameOf(<BorderedMultilineInput maxDisplayWidth={40} value="a goal" />),
    ).toContain("a goal");
  });
});

describe("SegmentedCronInput", () => {
  test("renders every cron field label and the joined expression", () => {
    const frame = frameOf(
      <SegmentedCronInput
        activeFieldIndex={0}
        expression="0 9 * * 1"
        fallbackExpression="0 0 * * *"
        maxDisplayWidth={80}
      />,
    );
    for (const label of ["minute", "hour", "day", "month", "weekday"]) {
      expect(frame).toContain(label);
    }
    expect(frame).toContain("Cron: 0 9 * * 1");
  });
});

describe("ExternalCliAuthPrompt", () => {
  test("masks a pasted token in the detected state", () => {
    const frame = frameOf(
      <ExternalCliAuthPrompt
        authState={{ kind: "detected" }}
        input="ghp-secrettoken"
        provider="copilot"
      />,
    );
    expect(frame).not.toContain("ghp-secrettoken");
    expect(frame).toContain("Detected an existing");
  });

  test("prompts to run the login command when a cli is available", () => {
    const frame = frameOf(
      <ExternalCliAuthPrompt
        authState={{ kind: "not-detected", cliAvailable: true }}
        input=""
        provider="copilot"
      />,
    );
    expect(frame).toContain("No");
    expect(frame).toContain("Press Tab to run");
  });

  test("renders nothing for a provider without an external CLI adapter", () => {
    const frame = frameOf(
      <ExternalCliAuthPrompt
        authState={{ kind: "idle" }}
        input=""
        provider="anthropic"
      />,
    );
    expect(frame).toBe("");
  });

  test("shows the checking message while probing for a credential", () => {
    const frame = frameOf(
      <ExternalCliAuthPrompt
        authState={{ kind: "checking" }}
        input=""
        provider="copilot"
      />,
    );
    expect(frame).toContain("Checking for an existing");
  });

  test("shows the login-in-progress message while signing in", () => {
    const frame = frameOf(
      <ExternalCliAuthPrompt
        authState={{ kind: "logging-in" }}
        input=""
        provider="copilot"
      />,
    );
    expect(frame).toContain("follow the prompts in this");
  });

  test("reports a failed login when the command did not complete", () => {
    const frame = frameOf(
      <ExternalCliAuthPrompt
        authState={{ kind: "login-failed" }}
        input=""
        provider="copilot"
      />,
    );
    expect(frame).toContain("did not complete successfully");
  });

  test("shows the install hint when no cli is available", () => {
    const frame = frameOf(
      <ExternalCliAuthPrompt
        authState={{ kind: "not-detected", cliAvailable: false }}
        input=""
        provider="copilot"
      />,
    );
    expect(frame).toContain("Install");
    expect(frame).not.toContain("Press Tab to run");
  });
});

/**
 * Builds a full, valid props bag for the {@link Prompt} step router. Each test
 * overrides only the fields for the step under test, so the render is always
 * fully typed regardless of which branch is exercised.
 */
function makePromptProps(
  overrides: Partial<React.ComponentProps<typeof Prompt>> = {},
): React.ComponentProps<typeof Prompt> {
  return {
    codeRepoPathInput: "",
    codeRepoRoot: "/tmp/repo",
    codeRepoSelectionIndex: 0,
    externalCliAuth: { kind: "idle" },
    cronFieldSelectionIndex: 0,
    cronModeSelectionIndex: 0,
    finalSelectionIndex: 0,
    input: "",
    inputDisplayWidth: 64,
    isCustomModelInput: false,
    langsmithDraft: null,
    langsmithRegionSelectionIndex: 0,
    langsmithWorkspaceSelectionIndex: 0,
    langsmithWorkspaces: [],
    modelSelectionIndex: 0,
    onboardingConfig: createEmptyOnboardingConfig(),
    powerModeSelectionIndex: 0,
    provider: "anthropic",
    providerSelectionIndex: 0,
    runModeSelectionIndex: 0,
    secretInputIndex: 0,
    selectedMode: "personal",
    selectedSource: getSourceOption("git-repo"),
    sourceOptions: getTemplateSourceOptions(undefined),
    sourceContinueSelectionIndex: 0,
    sourceDescriptionSelectionIndex: 0,
    sourceSelectionIndex: 0,
    sourceState: { secretValues: {} },
    step: "provider",
    suggestedCronDescription: "At 02:00",
    suggestedCronExpression: "0 2 * * *",
    templateSelectionIndex: 0,
    ...overrides,
  };
}

/** Renders the Prompt step router and returns its ANSI-stripped final frame. */
function promptFrame(
  overrides: Partial<React.ComponentProps<typeof Prompt>> = {},
): string {
  return frameOf(<Prompt {...makePromptProps(overrides)} />);
}

describe("Prompt", () => {
  test("run-mode lists the initialization choices", () => {
    const frame = promptFrame({ step: "run-mode" });
    expect(frame).toContain("Choose what OpenWiki should initialize.");
    expect(frame).toContain("Use up/down arrows, then press Enter.");
  });

  test("provider lists the selectable model providers", () => {
    const frame = promptFrame({ step: "provider" });
    expect(frame).toContain("Choose a model provider.");
  });

  test("api-key prompts to paste the provider key and masks it", () => {
    const frame = promptFrame({
      step: "api-key",
      provider: "anthropic",
      input: "sk-secretvalue",
    });
    expect(frame).toContain("Paste your");
    expect(frame).toContain("ANTHROPIC_API_KEY=");
    expect(frame).not.toContain("sk-secretvalue");
  });

  test("external-cli-auth delegates to the external CLI prompt", () => {
    const frame = promptFrame({
      step: "external-cli-auth",
      provider: "copilot",
      externalCliAuth: { kind: "detected" },
    });
    expect(frame).toContain("Detected an existing");
  });

  test("secret-key prompts for the provider secret access key and masks it", () => {
    const frame = promptFrame({
      step: "secret-key",
      provider: "bedrock",
      input: "aws-secret-value",
    });
    expect(frame).toContain("secret access key");
    expect(frame).not.toContain("aws-secret-value");
  });

  test("gcp-project prompts for the Vertex project id", () => {
    const frame = promptFrame({
      step: "gcp-project",
      provider: "gemini-enterprise",
      input: "my-proj",
    });
    expect(frame).toContain("Google Cloud project ID");
    expect(frame).toContain("my-proj");
  });

  test("gcp-location prompts for a Vertex location", () => {
    const frame = promptFrame({
      step: "gcp-location",
      provider: "gemini-enterprise",
    });
    expect(frame).toContain("Vertex AI location");
  });

  test("base-url prompts for the provider base URL", () => {
    const frame = promptFrame({
      step: "base-url",
      provider: "openai-compatible",
      input: "https://api.local/v1",
    });
    expect(frame).toContain("base URL");
    expect(frame).toContain("https://api.local/v1");
  });

  test("region prompts for the provider region", () => {
    const frame = promptFrame({ step: "region", provider: "bedrock" });
    expect(frame).toContain("region");
    expect(frame).toContain("us-east-1");
  });

  test("model lists the provider model options by default", () => {
    const frame = promptFrame({ step: "model", provider: "anthropic" });
    expect(frame).toContain("model.");
    expect(frame).toContain("Custom model ID");
  });

  test("reasoning effort lists only the selected model's available values", () => {
    const frame = promptFrame({
      step: "reasoning-effort",
      reasoningEffortOptions: [
        { label: "Provider default", value: "" },
        { label: "none", value: "none" },
        { label: "low", value: "low" },
        { label: "high", value: "high" },
      ],
      reasoningEffortSelectionIndex: 2,
    });
    expect(frame).toContain("Choose the reasoning effort for this model.");
    expect(frame).toContain("Provider default preserves the provider setting");
    expect(frame).toContain("> low");
    expect(frame).not.toContain("max");
  });

  test("model in custom-input mode prompts for a pasted model id", () => {
    const frame = promptFrame({
      step: "model",
      isCustomModelInput: true,
      input: "claude-custom",
    });
    expect(frame).toContain("Paste a custom model ID.");
    expect(frame).toContain("claude-custom");
  });

  test("langsmith offers the optional tracing key and masks it", () => {
    const frame = promptFrame({ step: "langsmith", input: "ls-secretkey" });
    expect(frame).toContain("Optional: paste a LangSmith API key");
    expect(frame).not.toContain("ls-secretkey");
  });

  test("template shows suggested sources for a template that has them", () => {
    const frame = promptFrame({ step: "template", templateSelectionIndex: 0 });
    expect(frame).toContain("Choose how OpenWiki should run.");
    expect(frame).toContain("Suggested sources:");
  });

  test("wiki-goal shows the brief editor and the config mode name", () => {
    const frame = promptFrame({
      step: "wiki-goal",
      onboardingConfig: {
        ...createEmptyOnboardingConfig(),
        modeId: "code",
        modeName: "Code wiki",
      },
      input: "document the repo",
    });
    expect(frame).toContain("Edit wiki brief");
    expect(frame).toContain("Mode: Code wiki");
    expect(frame).toContain("document the repo");
  });

  test("code-repo-confirm shows the detected repository root", () => {
    const frame = promptFrame({
      step: "code-repo-confirm",
      codeRepoRoot: "/home/me/project",
    });
    expect(frame).toContain("Use this repository?");
    expect(frame).toContain("/home/me/project");
  });

  test("code-repo-path prompts for the repository directory", () => {
    const frame = promptFrame({
      step: "code-repo-path",
      codeRepoPathInput: "/home/me/other",
    });
    expect(frame).toContain("Choose the repository directory.");
    expect(frame).toContain("/home/me/other");
  });

  test("source-menu flags no sources configured on an empty config", () => {
    const frame = promptFrame({ step: "source-menu" });
    expect(frame).toContain("Configure sources for this mode.");
    expect(frame).toContain("(no sources configured)");
  });

  test("source-menu counts a configured source instance", () => {
    const frame = promptFrame({
      step: "source-menu",
      onboardingConfig: {
        ...createEmptyOnboardingConfig(),
        sourceInstances: [{ connectorId: "git-repo", id: "git-repo:1" }],
      },
      sourceOptions: [getSourceOption("git-repo")],
    });
    expect(frame).toContain("[configured]");
    expect(frame).not.toContain("(no sources configured)");
  });

  test("source-menu lists a named source instance under its connector", () => {
    const frame = promptFrame({
      step: "source-menu",
      onboardingConfig: {
        ...createEmptyOnboardingConfig(),
        sourceInstances: [
          { connectorId: "git-repo", id: "git-repo:1", name: "My checkout" },
        ],
      },
      sourceOptions: [getSourceOption("git-repo")],
    });
    expect(frame).toContain("My checkout");
    expect(frame).toContain("(git-repo:1)");
  });

  test("source-menu lists configured LangSmith workspaces by region", () => {
    const frame = promptFrame({
      step: "source-menu",
      sourceOptions: [getSourceOption("langsmith")],
      langsmithWorkspaces: [
        {
          apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY_ACME",
          apiKey: "",
          region: "us",
          projects: ["proj-a"],
        },
      ],
    });
    expect(frame).toContain("proj-a");
    expect(frame).not.toContain("(no sources configured)");
  });

  test("source-langsmith-workspaces lists an existing workspace", () => {
    const frame = promptFrame({
      step: "source-langsmith-workspaces",
      langsmithWorkspaces: [
        {
          apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY_ACME",
          apiKey: "",
          region: "eu",
          projects: ["proj-b"],
        },
      ],
    });
    expect(frame).toContain("proj-b");
  });

  test("source-path prompts for the local Git repository directory", () => {
    const frame = promptFrame({ step: "source-path", input: "/repo/here" });
    expect(frame).toContain("Choose the local Git repository directory.");
    expect(frame).toContain("/repo/here");
  });

  test("source-secret renders the credential input for a source that needs one", () => {
    const frame = promptFrame({
      step: "source-secret",
      selectedSource: getSourceOption("web-search"),
      input: "tvly-secret",
    });
    expect(frame).toContain("setup");
    expect(frame).toContain("Enter credential");
    expect(frame).not.toContain("tvly-secret");
  });

  test("source-auth shows the callback hint before an auth URL exists", () => {
    const frame = promptFrame({
      step: "source-auth",
      selectedSource: getSourceOption("notion"),
    });
    expect(frame).toContain("authorization");
    expect(frame).toContain("Press Enter to open the authorization URL");
  });

  test("source-auth renders the authorization link once a URL is available", () => {
    const frame = promptFrame({
      step: "source-auth",
      selectedSource: getSourceOption("notion"),
      sourceState: {
        secretValues: {},
        authUrl: "https://auth.example/authorize",
      },
    });
    expect(frame).toContain("Open authorization URL");
  });

  test("source-description lists example descriptions and a custom option", () => {
    const frame = promptFrame({
      step: "source-description",
      selectedSource: getSourceOption("git-repo"),
    });
    expect(frame).toContain("Custom description");
  });

  test("source-description-custom offers a free-form description editor", () => {
    const frame = promptFrame({
      step: "source-description-custom",
      selectedSource: getSourceOption("git-repo"),
      input: "focus on the API",
    });
    expect(frame).toContain("Type what OpenWiki should focus on");
    expect(frame).toContain("focus on the API");
  });

  test("source-langsmith-workspaces lists the add and done actions", () => {
    const frame = promptFrame({ step: "source-langsmith-workspaces" });
    expect(frame).toContain("LangSmith workspaces to document.");
    expect(frame).toContain("Add a workspace");
    expect(frame).toContain("Done");
  });

  test("source-langsmith-key uses the draft env key and masks the value", () => {
    const frame = promptFrame({
      step: "source-langsmith-key",
      langsmithDraft: {
        apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY_ACME",
        apiKey: "",
        region: "us",
        projects: [],
      },
      input: "lsv2-secret",
    });
    expect(frame).toContain("OPENWIKI_LANGSMITH_API_KEY_ACME=");
    expect(frame).not.toContain("lsv2-secret");
  });

  test("source-langsmith-key falls back to a default env key without a draft", () => {
    const frame = promptFrame({ step: "source-langsmith-key" });
    expect(frame).toContain("OPENWIKI_LANGSMITH_API_KEY=");
  });

  test("source-langsmith-projects prompts for comma-separated projects", () => {
    const frame = promptFrame({
      step: "source-langsmith-projects",
      input: "proj-a, proj-b",
    });
    expect(frame).toContain("Which projects should this wiki document");
    expect(frame).toContain("proj-a, proj-b");
  });

  test("source-langsmith-region lists the LangSmith regions", () => {
    const frame = promptFrame({ step: "source-langsmith-region" });
    expect(frame).toContain("Which LangSmith region");
    expect(frame).toContain("US");
    expect(frame).toContain("EU");
  });

  test("global-cron-mode uses code-mode copy for a code wiki", () => {
    const frame = promptFrame({
      step: "global-cron-mode",
      onboardingConfig: { ...createEmptyOnboardingConfig(), modeId: "code" },
    });
    expect(frame).toContain("GitHub Actions refresh this code wiki");
    expect(frame).toContain("Suggested: At 02:00");
  });

  test("global-cron-mode uses personal copy for a non-code wiki", () => {
    const frame = promptFrame({
      step: "global-cron-mode",
      onboardingConfig: {
        ...createEmptyOnboardingConfig(),
        modeId: "personal",
      },
    });
    expect(frame).toContain("run all ingestion");
  });

  test("global-cron-custom shows the example hint when the field is empty", () => {
    const frame = promptFrame({ step: "global-cron-custom", input: "" });
    expect(frame).toContain("Example: 0 2 * * *");
  });

  test("global-cron-custom describes a valid entered schedule", () => {
    const frame = promptFrame({
      step: "global-cron-custom",
      input: "0 2 * * *",
    });
    expect(frame).toContain("At 02:00 AM");
    expect(frame).not.toContain("Example: 0 2 * * *");
  });

  test("global-cron-custom surfaces the error for an invalid schedule", () => {
    const frame = promptFrame({
      step: "global-cron-custom",
      input: "99 2 * * *",
    });
    expect(frame).toContain("Constraint error");
  });

  test("global-power-mode explains the macOS wake schedule", () => {
    const frame = promptFrame({ step: "global-power-mode" });
    expect(frame).toContain("Keep your Mac awake");
  });

  test("global-power-mode surfaces a saved schedule warning when present", () => {
    const frame = promptFrame({
      step: "global-power-mode",
      sourceState: { secretValues: {}, savedScheduleWarning: "pmset drift" },
    });
    expect(frame).toContain("pmset drift");
  });

  test("source-confirm-continue lists the unconfigured sources", () => {
    const frame = promptFrame({
      step: "source-confirm-continue",
      sourceOptions: [getSourceOption("web-search")],
      onboardingConfig: createEmptyOnboardingConfig(),
    });
    expect(frame).toContain("not configured yet");
    expect(frame).toContain("Web Search (Tavily)");
  });

  test("final uses code-mode copy for a code wiki", () => {
    const frame = promptFrame({ step: "final", selectedMode: "code" });
    expect(frame).toContain("Setup is complete.");
    expect(frame).toContain("Run now writes the initial openwiki/ directory");
  });

  test("final uses personal-mode copy for a personal wiki", () => {
    const frame = promptFrame({ step: "final", selectedMode: "personal" });
    expect(frame).toContain("Setup is complete.");
    expect(frame).toContain("one source-specific ingestion");
  });

  test("renders nothing for a step the router does not handle", () => {
    const frame = promptFrame({ step: "oauth-login" });
    expect(frame).toBe("");
  });
});
