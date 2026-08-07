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
  SegmentedCronInput,
  SelectionMarker,
  SetupHeader,
  SetupPanel,
  SetupStep,
  SourceConnectionStatus,
} from "../../../src/setup/credentials/components.tsx";
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
});
