import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, test } from "vitest";
import {
  AuthFixPanel,
  CredentialDiagnosticsPanel,
  DryRunView,
  ErrorDiagnosticsPanel,
  HelpView,
} from "../../../src/cli/components/panels.tsx";
import type { CredentialDiagnostic } from "../../../src/config/env.ts";
import type { AuthFix } from "../../../src/cli/diagnostics/auth-fix.ts";
import type { ErrorDiagnostic } from "../../../src/cli/diagnostics/error-diagnostics.ts";
import { stripAnsi as plain } from "./ansi.ts";

describe("HelpView", () => {
  test("renders the usage, commands, options, and examples sections", () => {
    const { lastFrame } = render(<HelpView />);
    const frame = plain(lastFrame());

    expect(frame).toContain("# Usage");
    expect(frame).toContain("# Commands");
    expect(frame).toContain("# Options");
    expect(frame).toContain("# Examples");
  });
});

describe("DryRunView", () => {
  test("renders the execution plan for a would-start run", () => {
    const { lastFrame } = render(
      <DryRunView
        command="init"
        modelId="opus"
        shouldStart
        userMessage="seed the wiki"
      />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Execution Plan");
    expect(frame).toContain("openwiki init");
    expect(frame).toContain("would start run");
    expect(frame).toContain("not invoked");
    expect(frame).toContain("seed the wiki");
  });

  test("shows the chat path and omits the message row when absent", () => {
    const { lastFrame } = render(
      <DryRunView
        command="chat"
        modelId={null}
        shouldStart={false}
        userMessage={null}
      />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("would open chat");
    expect(frame).not.toContain("Message");
  });
});

describe("CredentialDiagnosticsPanel", () => {
  test("shows source, length, preview, and warnings but never the raw value", () => {
    const diagnostics: CredentialDiagnostic[] = [
      {
        key: "ANTHROPIC_API_KEY",
        source: "~/.openwiki/.env",
        length: 40,
        preview: "sk-a...z9",
        warnings: ["trailing whitespace"],
      },
    ];

    const { lastFrame } = render(
      <CredentialDiagnosticsPanel diagnostics={diagnostics} />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Raw secret values are intentionally not printed.");
    expect(frame).toContain("ANTHROPIC_API_KEY");
    expect(frame).toContain("source=~/.openwiki/.env");
    expect(frame).toContain("length=40");
    expect(frame).toContain("preview=sk-a...z9");
    expect(frame).toContain("warnings=trailing whitespace");
  });

  test("renders length=unset and warnings=none for an unset credential", () => {
    const diagnostics: CredentialDiagnostic[] = [
      {
        key: "OPENAI_API_KEY",
        source: "unset",
        length: null,
        preview: "",
        warnings: [],
      },
    ];

    const { lastFrame } = render(
      <CredentialDiagnosticsPanel diagnostics={diagnostics} />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("length=unset");
    expect(frame).toContain("warnings=none");
  });
});

describe("AuthFixPanel", () => {
  test("names the failing env key and points to --debug", () => {
    const authFix: AuthFix = {
      apiKeyEnvKey: "ANTHROPIC_API_KEY",
      keyFromShell: true,
      provider: "anthropic",
    };

    const { lastFrame } = render(<AuthFixPanel authFix={authFix} />);
    const frame = plain(lastFrame());

    expect(frame).toContain("How to fix");
    expect(frame).toContain("ANTHROPIC_API_KEY");
    expect(frame).toContain("re-run with --debug");
  });
});

describe("ErrorDiagnosticsPanel", () => {
  test("renders the debug gate notice and allowlisted label/value pairs", () => {
    const diagnostics: ErrorDiagnostic[] = [
      { label: "response.status", value: "401" },
      { label: "header.x-request-id", value: "abc123" },
    ];

    const { lastFrame } = render(
      <ErrorDiagnosticsPanel diagnostics={diagnostics} />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Error Diagnostics");
    expect(frame).toContain("OPENWIKI_DEBUG=1");
    expect(frame).toContain("response.status 401");
    expect(frame).toContain("header.x-request-id abc123");
  });
});
