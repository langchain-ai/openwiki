import React from "react";
import { Box, Text } from "ink";
import type { OpenWikiCommand } from "../../agent/types.js";
import { openWikiLocalWikiDisplayPath } from "../../config/openwiki-home.js";
import {
  getDefaultModelId,
  resolveConfiguredProvider,
} from "../../config/constants.js";
import type { CredentialDiagnostic } from "../../config/env.js";
import { helpContent, isDevelopmentMode } from "../commands.js";
import { getAuthFixSteps, type AuthFix } from "../diagnostics/auth-fix.js";
import type { ErrorDiagnostic } from "../diagnostics/error-diagnostics.js";
import { Header } from "./header.js";
import { Panel, Rows, StatusLine } from "./primitives.js";

/**
 * The `--help` screen: usage, commands, options, and examples, gated to also
 * show development-only rows when running in development mode.
 */
export function HelpView() {
  return (
    <Box flexDirection="column">
      <Header modelId={null} subtitle={helpContent.description} />

      <Panel title="Usage">
        {helpContent.usage.map((line) => (
          <Text key={line}> {line}</Text>
        ))}
      </Panel>

      <Panel title="Commands">
        <Rows rows={helpContent.commands} />
      </Panel>

      <Panel title="Options">
        <Rows rows={helpContent.options} />
      </Panel>

      {isDevelopmentMode() ? (
        <Panel title="Development Options">
          <Rows rows={helpContent.developmentOptions} />
        </Panel>
      ) : null}

      <Panel title="Examples">
        {helpContent.examples.map((line) => (
          <Text key={line}> {line}</Text>
        ))}
        {isDevelopmentMode()
          ? helpContent.developmentExamples.map((line) => (
              <Text key={line}> {line}</Text>
            ))
          : null}
      </Panel>
    </Box>
  );
}

/**
 * Props for the development dry-run execution-plan view.
 */
interface DryRunViewProps {
  command: OpenWikiCommand;
  modelId: string | null;
  shouldStart: boolean;
  userMessage: string | null;
}

/**
 * The `--dry-run` execution plan: shows what a run would do without reading
 * credentials, invoking the agent, or writing any files.
 */
export function DryRunView({
  command,
  modelId,
  shouldStart,
  userMessage,
}: DryRunViewProps) {
  return (
    <Box flexDirection="column">
      <Header modelId={modelId} subtitle="Development dry run" />
      <Panel title="Execution Plan">
        <StatusLine
          tone="active"
          label="Command"
          value={`openwiki ${command}`}
        />
        <StatusLine tone="muted" label="Mode" value={command} />
        <StatusLine
          tone="muted"
          label="Credentials"
          value="not read or requested"
        />
        <StatusLine
          tone="muted"
          label="Model"
          value={
            modelId ??
            `saved setting or ${getDefaultModelId(resolveConfiguredProvider())}`
          }
        />
        <StatusLine tone="muted" label="Agent" value="not invoked" />
        <StatusLine tone="muted" label="Writes" value="no files or metadata" />
        <StatusLine
          tone="muted"
          label="Output"
          value={openWikiLocalWikiDisplayPath}
        />
        <StatusLine
          tone="muted"
          label="Startup"
          value={shouldStart ? "would start run" : "would open chat"}
        />
        {userMessage ? (
          <StatusLine tone="muted" label="Message" value={userMessage} />
        ) : null}
      </Panel>
    </Box>
  );
}

/**
 * Diagnostics for configured credentials. Explicitly never prints raw secret
 * values; only the source, length, a safe preview, and any warnings.
 */
export function CredentialDiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: CredentialDiagnostic[];
}) {
  return (
    <Panel title="Credential Diagnostics">
      <Text color="gray">Raw secret values are intentionally not printed.</Text>
      {diagnostics.map((diagnostic) => (
        <Box flexDirection="column" key={diagnostic.key} marginTop={1}>
          <Text>
            <Text bold>{diagnostic.key}</Text>{" "}
            <Text color="gray">source={diagnostic.source}</Text>
          </Text>
          <Text>
            length={diagnostic.length ?? "unset"} preview={diagnostic.preview}
          </Text>
          <Text color={diagnostic.warnings.length > 0 ? "yellow" : "gray"}>
            warnings=
            {diagnostic.warnings.length > 0
              ? diagnostic.warnings.join(", ")
              : "none"}
          </Text>
        </Box>
      ))}
    </Panel>
  );
}

/**
 * The ordered "how to fix" steps for an auth failure. Shared by the interactive
 * panel and the --print stderr path so they stay in sync. Names env keys only,
 * never secret values.
 */
export function AuthFixPanel({ authFix }: { authFix: AuthFix }) {
  const steps = getAuthFixSteps(authFix);

  return (
    <Panel title="How to fix">
      <Text>Your provider rejected the credentials for this run.</Text>
      {steps.map((step, index) => (
        <Text key={step}>
          <Text color="cyan">{index + 1}. </Text>
          {step}
        </Text>
      ))}
      <Text color="gray">For full detail, re-run with --debug.</Text>
    </Panel>
  );
}

/**
 * Debug-mode error diagnostics. Only allowlisted, non-secret error fields are
 * shown, gated behind OPENWIKI_DEBUG.
 */
export function ErrorDiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: ErrorDiagnostic[];
}) {
  return (
    <Panel title="Error Diagnostics">
      <Text color="gray">
        OPENWIKI_DEBUG=1 is enabled. Only allowlisted, non-secret error fields
        are shown.
      </Text>
      {diagnostics.map((diagnostic) => (
        <Text key={diagnostic.label}>
          <Text bold>{diagnostic.label}</Text> {diagnostic.value}
        </Text>
      ))}
    </Panel>
  );
}
