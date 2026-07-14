#!/usr/bin/env node
import React, { useEffect, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import { marked, type Token, type Tokens } from "marked";
import {
  configureAuthProvider,
  listAuthProviderTools,
  shouldDiscoverToolsAfterAuth,
} from "./auth/configure.js";
import { startNgrokTunnel } from "./auth/ngrok.js";
import { formatAuthProviderList, runOAuthAuth } from "./auth/oauth.js";
import { ensureCodeModeRepoSetup } from "./code-mode.js";
import {
  helpContent,
  isDevelopmentMode,
  parseCommand,
  shouldRunNonInteractively,
  type CliCommand,
  type HelpRow,
  type OpenWikiRunMode,
} from "./commands.js";
import { resolveStartupCommand } from "./startup.js";
import {
  InitSetup,
  needsCredentialSetup,
  type InitSetupResult,
} from "./credentials.js";
import {
  getCredentialDiagnostics,
  loadOpenWikiEnv,
  saveOpenWikiEnv,
  type CredentialDiagnostic,
} from "./env.js";
import { createOpenWikiThreadId, runOpenWikiAgent } from "./agent/index.js";
import { formatChatGptAccountFromEnv } from "./agent/openai-chatgpt-oauth.js";
import {
  getErrorMessage,
  isSecretLikeKey,
  sanitizeDiagnosticText,
} from "./diagnostics.js";
import { stripHtmlTags } from "./utils.js";
import {
  type OpenWikiRunEvent,
  type OpenWikiRunResult,
} from "./agent/types.js";
import {
  runOpenWikiIngestion,
  type OpenWikiIngestionResult,
} from "./ingestion.js";
import {
  readOpenWikiOnboardingConfig,
  saveOpenWikiOnboardingConfig,
} from "./onboarding.js";
import { openWikiLocalWikiDir } from "./openwiki-home.js";
import {
  deleteConnectorSchedules,
  getSavedPowerScheduleStatus,
  listConnectorSchedules,
  pauseConnectorSchedules,
  resumeConnectorSchedules,
  type ConnectorScheduleStatus,
  type PowerScheduleStatus,
  type ScheduleMutationResult,
} from "./schedules.js";
import {
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderLabel,
  getProviderModelOptions,
  isValidModelId,
  normalizeModelId,
  normalizeProvider,
  OPENWIKI_PROVIDER_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  resolveConfiguredProvider,
  SELECTABLE_OPENWIKI_PROVIDERS,
  OPENWIKI_VERSION,
  type OpenWikiProvider,
} from "./constants.js";
import type { OpenWikiCommand, OpenWikiOutputMode } from "./agent/types.js";

type RunState =
  | { status: "idle" }
  | { status: "setup-complete-exit"; result: InitSetupResult }
  | { status: "init-setup-saved"; result: InitSetupResult }
  | {
      status: "ingestion-running";
      log: RunLogItem[];
      credentialDiagnostics?: CredentialDiagnostic[];
    }
  | {
      status: "ingestion-success";
      result: OpenWikiIngestionResult;
      log: RunLogItem[];
      credentialDiagnostics?: CredentialDiagnostic[];
    }
  | {
      status: "running";
      command: OpenWikiCommand;
      log: RunLogItem[];
      credentialDiagnostics?: CredentialDiagnostic[];
    }
  | {
      status: "success";
      result: OpenWikiRunResult;
      log: RunLogItem[];
      credentialDiagnostics?: CredentialDiagnostic[];
    }
  | {
      status: "error";
      message: string;
      credentialDiagnostics?: CredentialDiagnostic[];
      errorDiagnostics?: ErrorDiagnostic[];
    };

type RunLogItem = {
  actionCount?: number;
  activeToolCallIds?: string[];
  call?: string;
  doneContent?: string;
  errorCount?: number;
  id: number;
  latestDoneContent?: string;
  status?: "done" | "error" | "running";
  toolCallId?: string;
  toolName?: string;
  type: "debug" | "text" | "tool";
  content: string;
};

type CompletedRun = {
  id: number;
  command: OpenWikiCommand;
  credentialDiagnostics?: CredentialDiagnostic[];
  log: RunLogItem[];
  message: string | null;
  result: OpenWikiRunResult;
};

type ErrorDiagnostic = {
  label: string;
  value: string;
};

type AppProps = {
  command: CliCommand;
};

const OPENWIKI_LOGO_LINES = [
  "  ___                  __        ___ _    _ ",
  " / _ \\ _ __   ___ _ __ \\ \\      / (_) | _(_)",
  "| | | | '_ \\ / _ \\ '_ \\ \\ \\ /\\ / /| | |/ / |",
  "| |_| | |_) |  __/ | | | \\ V  V / | |   <| |",
  " \\___/| .__/ \\___|_| |_|  \\_/\\_/  |_|_|\\_\\_|",
  "      |_|",
];
const OPENWIKI_LOGO_WIDTH = Math.max(
  ...OPENWIKI_LOGO_LINES.map((line) => line.length),
);

function App({ command }: AppProps) {
  const app = useApp();
  const startupModelId = command.kind === "run" ? command.modelId : null;
  const startupRunMode = command.kind === "run" ? command.mode : "personal";
  const [runMode, setRunMode] = useState<OpenWikiRunMode>(startupRunMode);
  const [codeRuntimeCwd, setCodeRuntimeCwd] = useState(process.cwd());
  const runtimeCwd = getRunModeCwd(runMode, codeRuntimeCwd);
  const runtimeOutputMode = getRunModeOutputMode(runMode);
  const startupProvider = resolveConfiguredProvider();
  const autoExitOnSuccess = shouldAutoExitStartupRun(command);
  const [sessionProvider, setSessionProvider] =
    useState<OpenWikiProvider>(startupProvider);
  const [sessionModelId, setSessionModelId] = useState<string | null>(
    startupModelId,
  );
  const activeRunId = useRef(0);
  const sessionThreadId = useRef(createOpenWikiThreadId(runtimeCwd));
  const sessionThreadMode = useRef<OpenWikiRunMode>(runMode);
  const mountedRef = useRef(false);
  const nextLogId = useRef(1);
  const nextCompletedRunId = useRef(1);
  const activeRunCredentialDiagnostics = useRef<
    CredentialDiagnostic[] | undefined
  >(undefined);
  const activeRunLog = useRef<RunLogItem[]>([]);
  const [runState, setRunState] = useState<RunState>({ status: "idle" });
  const [completedRuns, setCompletedRuns] = useState<CompletedRun[]>([]);
  const [activeUserMessage, setActiveUserMessage] = useState<string | null>(
    command.kind === "run" ? command.userMessage : null,
  );
  const [activeMessageIsFollowup, setActiveMessageIsFollowup] = useState(
    command.kind === "run" && command.command === "chat",
  );
  const shouldOpenSetupForExplicitModeChat =
    command.kind === "run" &&
    !command.dryRun &&
    !command.shouldStart &&
    command.modeSource !== "default" &&
    process.stdin.isTTY &&
    needsCredentialSetup(sessionModelId, runMode);
  const [resolvedCommand, setResolvedCommand] =
    useState<OpenWikiCommand | null>(
      command.kind === "run" &&
        (command.shouldStart || shouldOpenSetupForExplicitModeChat)
        ? command.command
        : null,
    );
  const shouldRunInteractiveCredentialSetup =
    command.kind === "run" &&
    resolvedCommand !== null &&
    !command.dryRun &&
    process.stdin.isTTY &&
    runState.status === "idle" &&
    needsCredentialSetup(sessionModelId, runMode);
  const displayModelId = sessionModelId ?? startupModelId;

  function submitChatMessage(message: string) {
    if (isExitMessage(message)) {
      process.exitCode = 0;
      app.exit();
      return;
    }

    setActiveUserMessage(message);
    setActiveMessageIsFollowup(true);
    setResolvedCommand("chat");
    setRunState({ status: "idle" });
  }

  function submitCommandRun(
    nextCommand: Extract<OpenWikiCommand, "init" | "update">,
    message: string | null,
  ) {
    setActiveUserMessage(message);
    setActiveMessageIsFollowup(false);
    setResolvedCommand(nextCommand);
    setRunState({ status: "idle" });
  }

  function startIngestionRun(modelId: string | null) {
    const runId = activeRunId.current + 1;
    activeRunId.current = runId;
    activeRunCredentialDiagnostics.current = undefined;
    activeRunLog.current = [];
    setResolvedCommand(null);
    setActiveUserMessage(
      "Run source-specific OpenWiki ingestion for configured sources.",
    );
    setActiveMessageIsFollowup(false);
    setRunState({
      status: "ingestion-running",
      log: [],
    });

    void runOpenWikiIngestion(process.cwd(), {
      debug: isDebugMode(),
      modelId,
      target: "all",
      onEvent: (event) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        activeRunLog.current = appendRunLogEvent(
          activeRunLog.current,
          event,
          nextLogId,
        );
        setRunState((currentState) =>
          currentState.status === "ingestion-running"
            ? {
                ...currentState,
                log: activeRunLog.current,
              }
            : currentState,
        );
      },
    })
      .then((result) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        if (
          result.results.some((sourceResult) => sourceResult.status === "error")
        ) {
          process.exitCode = 1;
        }

        setRunState({
          status: "ingestion-success",
          result,
          log: activeRunLog.current,
          credentialDiagnostics: activeRunCredentialDiagnostics.current,
        });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        const errorDiagnostics = getErrorDiagnostics(error);
        const message = getErrorMessage(error);

        void getCredentialDiagnostics()
          .catch(() => undefined)
          .then((credentialDiagnostics) => {
            if (!mountedRef.current || activeRunId.current !== runId) {
              return;
            }

            setRunState({
              status: "error",
              message,
              credentialDiagnostics,
              errorDiagnostics,
            });
          });
      });
  }

  function clearSession() {
    activeRunId.current += 1;
    sessionThreadId.current = createOpenWikiThreadId(runtimeCwd);
    activeRunCredentialDiagnostics.current = undefined;
    activeRunLog.current = [];
    nextLogId.current = 1;
    nextCompletedRunId.current = 1;
    setCompletedRuns([]);
    setActiveUserMessage(null);
    setActiveMessageIsFollowup(false);
    setResolvedCommand(null);
    setRunState({ status: "idle" });
  }

  async function selectModel(modelId: string) {
    await saveOpenWikiEnv({
      [OPENWIKI_MODEL_ID_ENV_KEY]: modelId,
    });
    setSessionModelId(modelId);
  }

  async function selectProvider(provider: OpenWikiProvider) {
    const modelId = getDefaultModelId(provider);

    await saveOpenWikiEnv({
      [OPENWIKI_PROVIDER_ENV_KEY]: provider,
      [OPENWIKI_MODEL_ID_ENV_KEY]: modelId,
    });
    setSessionProvider(provider);
    setSessionModelId(modelId);
  }

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (sessionThreadMode.current === runMode) {
      return;
    }

    sessionThreadId.current = createOpenWikiThreadId(runtimeCwd);
    sessionThreadMode.current = runMode;
  }, [runMode, runtimeCwd]);

  useEffect(() => {
    if (command.kind === "help" || command.kind === "error") {
      process.exitCode = command.exitCode;
      app.exit();
      return;
    }

    if (command.kind === "auth") {
      process.exitCode = command.exitCode;
      app.exit();
      return;
    }

    if (command.kind === "run" && command.dryRun) {
      process.exitCode = 0;
      app.exit();
      return;
    }

    if (command.kind !== "run") {
      return;
    }

    if (resolvedCommand === null) {
      return;
    }

    const apiKeyEnvKey = getProviderApiKeyEnvKey(sessionProvider);

    if (!process.env[apiKeyEnvKey] && !process.stdin.isTTY) {
      setRunState({
        status: "error",
        message: `${apiKeyEnvKey} is required. Run openwiki in an interactive terminal to save credentials.`,
      });
      return;
    }

    if (shouldRunInteractiveCredentialSetup) {
      return;
    }

    if (runState.status !== "idle" && runState.status !== "init-setup-saved") {
      return;
    }

    const runId = activeRunId.current + 1;
    const runMessage = activeUserMessage;

    activeRunId.current = runId;
    activeRunCredentialDiagnostics.current = undefined;
    activeRunLog.current = [];
    setRunState({
      status: "running",
      command: resolvedCommand,
      log: [],
    });

    if (shouldShowCredentialDiagnostics()) {
      void getCredentialDiagnostics()
        .catch(() => undefined)
        .then((credentialDiagnostics) => {
          if (
            !mountedRef.current ||
            activeRunId.current !== runId ||
            !credentialDiagnostics
          ) {
            return;
          }

          setRunState((currentState) =>
            updateRunningCredentialDiagnostics(
              currentState,
              credentialDiagnostics,
              activeRunCredentialDiagnostics,
            ),
          );
        });
    }

    const setupPromise =
      runMode === "code"
        ? ensureCodeModeRepoSetup(runtimeCwd)
        : Promise.resolve();

    setupPromise
      .then(() =>
        runOpenWikiAgent(resolvedCommand, runtimeCwd, {
          debug: isDebugMode(),
          isFollowup: activeMessageIsFollowup,
          modelId: sessionModelId,
          outputMode: runtimeOutputMode,
          threadId: sessionThreadId.current,
          userMessage: activeUserMessage,
          onEvent: (event) => {
            if (!mountedRef.current || activeRunId.current !== runId) {
              return;
            }

            activeRunLog.current = appendRunLogEvent(
              activeRunLog.current,
              event,
              nextLogId,
            );
            setRunState((currentState) =>
              currentState.status === "running"
                ? {
                    ...currentState,
                    log: activeRunLog.current,
                  }
                : currentState,
            );
          },
        }),
      )
      .then((result) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        setRunState({
          status: "success",
          result,
          log: activeRunLog.current,
          credentialDiagnostics: activeRunCredentialDiagnostics.current,
        });
        setCompletedRuns((runs) => [
          ...runs,
          {
            id: nextCompletedRunId.current,
            command: result.command,
            credentialDiagnostics: activeRunCredentialDiagnostics.current,
            log: activeRunLog.current,
            message: runMessage,
            result,
          },
        ]);
        nextCompletedRunId.current += 1;
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        const errorDiagnostics = getErrorDiagnostics(error);
        const message = getErrorMessage(error);

        void getCredentialDiagnostics()
          .catch(() => undefined)
          .then((credentialDiagnostics) => {
            if (!mountedRef.current || activeRunId.current !== runId) {
              return;
            }

            setRunState({
              status: "error",
              message,
              credentialDiagnostics,
              errorDiagnostics,
            });
          });
      });
  }, [
    app,
    command,
    activeMessageIsFollowup,
    activeUserMessage,
    resolvedCommand,
    runMode,
    runState.status,
    runtimeCwd,
    runtimeOutputMode,
    sessionModelId,
    sessionProvider,
    shouldRunInteractiveCredentialSetup,
  ]);

  useEffect(() => {
    if (runState.status === "error") {
      process.exitCode = 1;
      app.exit();
      return;
    }

    if (runState.status === "success" && autoExitOnSuccess) {
      process.exitCode = 0;
      app.exit();
      return;
    }

    if (runState.status === "ingestion-success" && autoExitOnSuccess) {
      process.exitCode = runState.result.results.some(
        (sourceResult) => sourceResult.status === "error",
      )
        ? 1
        : 0;
      app.exit();
    }
  }, [app, autoExitOnSuccess, runState]);

  if (command.kind === "help") {
    return <HelpView />;
  }

  if (command.kind === "error") {
    return (
      <Box flexDirection="column">
        <Header modelId={null} subtitle="Command failed" />
        <StatusLine tone="error" label="Error" value={command.message} />
        <HelpView />
      </Box>
    );
  }

  if (command.kind === "run" && command.dryRun) {
    return (
      <DryRunView
        command={command.command}
        modelId={command.modelId}
        shouldStart={command.shouldStart}
        userMessage={command.userMessage}
      />
    );
  }

  if (shouldRunInteractiveCredentialSetup) {
    return (
      <InitSetup
        allowModeSelection={false}
        mode={command.mode}
        modelIdOverride={command.modelId}
        onComplete={(result) => {
          const nextCodeRuntimeCwd = result.repoRoot ?? codeRuntimeCwd;

          if (result.repoRoot) {
            setCodeRuntimeCwd(result.repoRoot);
          }

          if (result.mode !== runMode) {
            const nextRuntimeCwd = getRunModeCwd(
              result.mode,
              nextCodeRuntimeCwd,
            );
            sessionThreadId.current = createOpenWikiThreadId(nextRuntimeCwd);
            sessionThreadMode.current = result.mode;
            setRunMode(result.mode);
          } else if (result.repoRoot) {
            sessionThreadId.current = createOpenWikiThreadId(result.repoRoot);
            sessionThreadMode.current = result.mode;
          }

          if (result.modelId) {
            setSessionModelId(result.modelId);
          }
          if (result.provider) {
            setSessionProvider(result.provider);
          }

          if (!result.shouldContinueToRun) {
            activeRunId.current += 1;
            setResolvedCommand(null);
            setActiveUserMessage(null);
            setActiveMessageIsFollowup(false);
            setRunState({ status: "idle" });
            return;
          }

          if (result.runIngestionNow && result.mode === "code") {
            if (command.kind === "run" && !command.shouldStart) {
              setResolvedCommand("init");
            }
            setActiveMessageIsFollowup(false);
            setRunState({ status: "init-setup-saved", result });
            return;
          }

          if (result.runIngestionNow) {
            startIngestionRun(result.modelId ?? sessionModelId);
            return;
          }

          setRunState({ status: "init-setup-saved", result });
        }}
        onError={(message) => {
          setRunState({ status: "error", message });
        }}
      />
    );
  }

  if (runState.status === "init-setup-saved") {
    return (
      <Box flexDirection="column">
        <Header
          modelId={runState.result.modelId ?? displayModelId}
          subtitle="Credential setup"
        />
        {runState.result.savedApiKey ||
        runState.result.savedProvider ||
        runState.result.savedBaseUrl ||
        runState.result.savedModelId ||
        runState.result.savedLangSmithKey ? (
          <StatusLine tone="success" label="Credentials" value="saved" />
        ) : null}
        {runState.result.provider ? (
          <StatusLine
            tone="muted"
            label="Provider"
            value={getProviderLabel(runState.result.provider)}
          />
        ) : null}
        {runState.result.modelId ? (
          <StatusLine
            tone="muted"
            label="Model"
            value={runState.result.modelId}
          />
        ) : null}
        <StatusLine tone="active" label="Next" value="starting openwiki" />
      </Box>
    );
  }

  if (runState.status === "setup-complete-exit") {
    return (
      <Box flexDirection="column">
        <Header
          modelId={runState.result.modelId ?? displayModelId}
          subtitle="Setup complete"
        />
        <StatusLine
          tone="success"
          label="Setup"
          value="saved; waiting for scheduled ingestion"
        />
      </Box>
    );
  }

  if (runState.status === "running") {
    return (
      <Box flexDirection="column">
        <ChatHistory runs={completedRuns} />
        <RunView
          command={runState.command}
          credentialDiagnostics={runState.credentialDiagnostics}
          log={runState.log}
          message={activeUserMessage}
          modelId={displayModelId}
        />
      </Box>
    );
  }

  if (runState.status === "ingestion-running") {
    return (
      <Box flexDirection="column">
        <ChatHistory runs={completedRuns} />
        <RunView
          command="update"
          credentialDiagnostics={runState.credentialDiagnostics}
          log={runState.log}
          message={activeUserMessage}
          modelId={displayModelId}
        />
      </Box>
    );
  }

  if (runState.status === "ingestion-success") {
    return (
      <Box flexDirection="column">
        <Header modelId={displayModelId} subtitle="Ingestion complete" />
        <IngestionSummary result={runState.result} />
        <RunView
          command="update"
          credentialDiagnostics={runState.credentialDiagnostics}
          done
          log={runState.log}
          message={activeUserMessage}
          modelId={displayModelId}
        />
      </Box>
    );
  }

  if (runState.status === "success") {
    if (autoExitOnSuccess) {
      return (
        <RunView
          command={runState.result.command}
          credentialDiagnostics={runState.credentialDiagnostics}
          done
          log={runState.log}
          message={activeUserMessage}
          modelId={runState.result.model}
        />
      );
    }

    return (
      <Box flexDirection="column">
        <Header
          modelId={runState.result.model}
          subtitle="Ready for follow-up"
        />
        <ChatHistory runs={completedRuns} />
        <ChatInput
          currentModelId={getDisplayModelId(displayModelId)}
          currentProvider={sessionProvider}
          onClear={clearSession}
          onCommandRun={submitCommandRun}
          onModelSelect={selectModel}
          onProviderSelect={selectProvider}
          onSubmit={submitChatMessage}
        />
      </Box>
    );
  }

  if (runState.status === "idle" && completedRuns.length > 0) {
    return (
      <Box flexDirection="column">
        <Header modelId={displayModelId} subtitle="Starting follow-up" />
        <ChatHistory runs={completedRuns} />
        {activeUserMessage ? <PromptBlock message={activeUserMessage} /> : null}
        <StatusLine tone="active" label="Next" value="starting openwiki" />
      </Box>
    );
  }

  if (runState.status === "error") {
    return (
      <Box flexDirection="column">
        <Header modelId={displayModelId} subtitle="Run failed" />
        <StatusLine tone="error" label="Error" value={runState.message} />
        {runState.credentialDiagnostics ? (
          <CredentialDiagnosticsPanel
            diagnostics={runState.credentialDiagnostics}
          />
        ) : null}
        {runState.errorDiagnostics && runState.errorDiagnostics.length > 0 ? (
          <ErrorDiagnosticsPanel diagnostics={runState.errorDiagnostics} />
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header modelId={displayModelId} subtitle="Ready for chat" />
      <ChatInput
        currentModelId={getDisplayModelId(displayModelId)}
        currentProvider={sessionProvider}
        onClear={clearSession}
        onCommandRun={submitCommandRun}
        onModelSelect={selectModel}
        onProviderSelect={selectProvider}
        onSubmit={submitChatMessage}
      />
    </Box>
  );
}

function HelpView() {
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

function DryRunView({
  command,
  modelId,
  shouldStart,
  userMessage,
}: {
  command: OpenWikiCommand;
  modelId: string | null;
  shouldStart: boolean;
  userMessage: string | null;
}) {
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
        <StatusLine tone="muted" label="Output" value="~/.openwiki/wiki" />
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

function CredentialDiagnosticsPanel({
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

function ErrorDiagnosticsPanel({
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

function Header({
  compact = false,
  modelId,
  showLogo = true,
  subtitle,
}: {
  compact?: boolean;
  modelId?: string | null;
  showLogo?: boolean;
  subtitle: string;
}) {
  const terminalColumns = process.stdout.columns ?? 80;
  const displayModelId = sanitizeHeaderValue(
    modelId ??
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
      getDefaultModelId(resolveConfiguredProvider()),
    Math.max(8, terminalColumns - 12),
  );
  const configuredProvider = resolveConfiguredProvider();
  const displayProvider = getProviderLabel(configuredProvider);
  const chatGptAccount =
    configuredProvider === "openai-chatgpt"
      ? formatChatGptAccountFromEnv()
      : null;
  const displayDirectory = sanitizeHeaderValue(
    formatCwd(process.cwd()),
    Math.max(8, terminalColumns - 17),
  );
  const shouldShowLogo = showLogo && terminalColumns > OPENWIKI_LOGO_WIDTH;
  const tracingEnabled =
    process.env.LANGCHAIN_TRACING_V2 === "true" &&
    Boolean(process.env.LANGSMITH_API_KEY);

  if (compact) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text wrap="truncate">
          <Text color="cyan">{">_ "}</Text>
          <Text bold>OpenWiki</Text>{" "}
          <Text color="gray">v{OPENWIKI_VERSION}</Text>{" "}
          <Text color="gray">provider: </Text>
          <Text color="white">{displayProvider}</Text>{" "}
          {chatGptAccount ? (
            <>
              <Text color="gray">account: </Text>
              <Text color="white">{chatGptAccount}</Text>{" "}
            </>
          ) : null}
          <Text color="gray">model: </Text>
          <Text color="white">{displayModelId}</Text>
        </Text>
        <Text>
          <Text color={tracingEnabled ? "green" : "gray"}>
            {tracingEnabled ? "* " : "- "}
          </Text>
          <Text color={tracingEnabled ? "green" : "gray"}>
            LangSmith tracing {tracingEnabled ? "enabled" : "disabled"}
          </Text>
          <Text color="gray"> - </Text>
          <Text color="cyan">{subtitle}</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {shouldShowLogo ? (
        <Box flexDirection="column" marginBottom={1}>
          {OPENWIKI_LOGO_LINES.map((line) => (
            <Text bold color="cyan" key={line} wrap="truncate">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box
        borderColor="cyan"
        borderStyle="round"
        flexDirection="column"
        marginBottom={1}
        paddingX={1}
      >
        <Text>
          <Text color="cyan">{">_ "}</Text>
          <Text bold>OpenWiki</Text>{" "}
          <Text color="gray">v{OPENWIKI_VERSION}</Text>{" "}
          <Text color="gray">agent docs for codebases</Text>
        </Text>
        <Text>
          <Text color="gray">provider: </Text>
          <Text color="white">{displayProvider}</Text>
        </Text>
        {chatGptAccount ? (
          <Text>
            <Text color="gray">account: </Text>
            <Text color="white">{chatGptAccount}</Text>
          </Text>
        ) : null}
        <Text>
          <Text color="gray">model: </Text>
          <Text color="white">{displayModelId}</Text>
        </Text>
        <Text>
          <Text color="gray">directory: </Text>
          <Text color="white">{displayDirectory}</Text>
        </Text>
      </Box>
      <Text>
        <Text color={tracingEnabled ? "green" : "gray"}>
          {tracingEnabled ? "* " : "- "}
        </Text>
        <Text color={tracingEnabled ? "green" : "gray"}>
          LangSmith tracing {tracingEnabled ? "enabled" : "disabled"}
        </Text>
        <Text color="gray"> - </Text>
        <Text color="cyan">{subtitle}</Text>
      </Text>
      <Text color="gray">
        Tip: ask for a docs change, or use /exit when you are done.
      </Text>
    </Box>
  );
}

type StatusLineProps = {
  tone: "active" | "error" | "muted" | "success";
  label: string;
  value: string;
};

function StatusLine({ tone, label, value }: StatusLineProps) {
  const color =
    tone === "success"
      ? "green"
      : tone === "error"
        ? "red"
        : tone === "active"
          ? "yellow"
          : "gray";

  return (
    <Text>
      <Text color={color}>* </Text>
      <Text bold color={color}>
        {label}
      </Text>{" "}
      <Text color={tone === "muted" ? "gray" : undefined}>{value}</Text>
    </Text>
  );
}

function IngestionSummary({ result }: { result: OpenWikiIngestionResult }) {
  return (
    <Panel title="Source Runs">
      {result.results.map((sourceResult) => (
        <StatusLine
          key={sourceResult.sourceInstanceId}
          label={sourceResult.displayName}
          tone={sourceResult.status === "error" ? "error" : "success"}
          value={`${sourceResult.status}; ${sourceResult.rawFiles.length} raw file(s)`}
        />
      ))}
    </Panel>
  );
}

type RunViewProps = {
  command: OpenWikiCommand;
  credentialDiagnostics?: CredentialDiagnostic[];
  log: RunLogItem[];
  done?: boolean;
  message?: string | null;
  modelId?: string | null;
};

function RunView({
  command,
  credentialDiagnostics,
  log,
  done = false,
  message = null,
  modelId = null,
}: RunViewProps) {
  const [animationFrame, setAnimationFrame] = useState(0);
  const activeRunningToolId = getActiveRunningToolLogId(log);
  const hasRunningTool = activeRunningToolId !== null;

  useEffect(() => {
    if (done || !hasRunningTool) {
      return;
    }

    const interval = setInterval(() => {
      setAnimationFrame((frame) => frame + 1);
    }, 140);

    return () => {
      clearInterval(interval);
    };
  }, [done, hasRunningTool]);

  return (
    <Box flexDirection="column">
      <Header
        compact
        modelId={modelId}
        showLogo={false}
        subtitle={done ? "Run complete" : "Agent running"}
      />
      {message ? <PromptBlock message={message} /> : null}
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color={done ? "green" : "cyan"}>* </Text>
          <Text bold>{done ? "Complete" : "Working"}</Text>{" "}
          <Text color="gray">openwiki {command}</Text>
          {!done ? <Text color="gray"> - streaming</Text> : null}
        </Text>
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          {log.length > 0 ? (
            log.map((item) => (
              <RunLogLine
                activeRunningToolId={activeRunningToolId}
                animationFrame={animationFrame}
                item={item}
                key={item.id}
              />
            ))
          ) : (
            <Text color="gray">Waiting for model output...</Text>
          )}
        </Box>
      </Box>
      {credentialDiagnostics ? (
        <CredentialDiagnosticsPanel diagnostics={credentialDiagnostics} />
      ) : null}
    </Box>
  );
}

function RunLogLine({
  activeRunningToolId = null,
  animationFrame = 0,
  item,
}: {
  activeRunningToolId?: number | null;
  animationFrame?: number;
  item: RunLogItem;
}) {
  if (item.type === "tool") {
    if (item.status === "running") {
      const isActive = item.id === activeRunningToolId;

      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text color={isActive ? "cyan" : "gray"}>
              {isActive ? `${getSpinnerFrame(animationFrame)} ` : "* "}
            </Text>
            <Text bold={isActive} color={isActive ? "cyan" : "gray"}>
              {item.content}
            </Text>
          </Text>
          {isActive && item.call ? (
            <Text color="gray"> {truncateLogOutput(item.call, "")}</Text>
          ) : null}
        </Box>
      );
    }

    if (item.status === "error") {
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text bold color="red">
              {"!! "}
            </Text>
            <Text bold color="red">
              {item.content}
            </Text>
          </Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">{"* "}</Text>
          <Text color="gray">{item.content}</Text>
        </Text>
      </Box>
    );
  }

  if (item.type === "debug") {
    return (
      <Text>
        <Text color="gray">- </Text>
        <Text color="gray">{item.content}</Text>
      </Text>
    );
  }

  return (
    <Box flexDirection="row">
      <Text color="white">* </Text>
      <Box flexDirection="column">
        <MarkdownText markdown={item.content.trim()} />
      </Box>
    </Box>
  );
}

function getActiveRunningToolLogId(log: RunLogItem[]): number | null {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const item = log[index];

    if (item.type === "tool" && item.status === "running") {
      return item.id;
    }
  }

  return null;
}

function getSpinnerFrame(frame: number): string {
  const frames = ["-", "\\", "|", "/"];

  return frames[frame % frames.length] ?? "-";
}

function MarkdownText({ markdown }: { markdown: string }) {
  const tokens = marked.lexer(markdown, {
    async: false,
    gfm: true,
  });

  return (
    <Box flexDirection="column">
      {tokens.map((token, index) => (
        <MarkdownBlock
          index={index}
          key={`${token.type}-${index}`}
          token={token}
        />
      ))}
    </Box>
  );
}

function MarkdownBlock({ index, token }: { index: number; token: Token }) {
  if (token.type === "space" || token.type === "def" || token.type === "hr") {
    return null;
  }

  if (token.type === "paragraph") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "heading") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "list") {
    return (
      <Box flexDirection="column">
        {(token as Tokens.List).items.map((item, itemIndex) => (
          <Text key={`${index}-${itemIndex}`} wrap="wrap">
            <Text color="gray">
              {(token as Tokens.List).ordered
                ? `${Number((token as Tokens.List).start || 1) + itemIndex}. `
                : "- "}
            </Text>
            <InlineMarkdown tokens={getTokenChildren(item)} />
          </Text>
        ))}
      </Box>
    );
  }

  if (token.type === "code") {
    return <Text color="gray">{token.text}</Text>;
  }

  if (token.type === "blockquote") {
    return (
      <Text wrap="wrap">
        <Text color="gray">| </Text>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "table") {
    return <Text color="gray">{renderPlainTable(token as Tokens.Table)}</Text>;
  }

  if (token.type === "html") {
    return <Text wrap="wrap">{renderHtmlToken(token)}</Text>;
  }

  if (token.type === "text") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={token.tokens ?? [token]} />
      </Text>
    );
  }

  return <Text wrap="wrap">{token.raw}</Text>;
}

function InlineMarkdown({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, index) => (
        <InlineMarkdownToken key={`${token.type}-${index}`} token={token} />
      ))}
    </>
  );
}

function InlineMarkdownToken({ token }: { token: Token }) {
  if (token.type === "text" || token.type === "escape") {
    return <>{token.text}</>;
  }

  if (token.type === "strong") {
    return (
      <Text bold>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "em") {
    return (
      <Text italic>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "link") {
    return (
      <Text underline>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "codespan") {
    return <Text color="gray">{token.text}</Text>;
  }

  if (token.type === "br") {
    return <>{"\n"}</>;
  }

  if (token.type === "del") {
    return (
      <Text strikethrough>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "html") {
    return <>{renderHtmlToken(token)}</>;
  }

  if ("tokens" in token && Array.isArray(token.tokens)) {
    return <InlineMarkdown tokens={token.tokens} />;
  }

  return <>{token.raw}</>;
}

function getTokenChildren(token: Token): Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function renderPlainTable(token: Tokens.Table): string {
  const header = token.header.map((cell) => cell.text).join(" | ");
  const rows = token.rows.map((row) =>
    row.map((cell) => cell.text).join(" | "),
  );

  return [header, ...rows].filter(Boolean).join("\n");
}

function renderHtmlToken(token: Token): React.ReactNode {
  const text =
    "text" in token && typeof token.text === "string" ? token.text : token.raw;
  const underlineMatch = text.match(/^<u>(.*)<\/u>$/isu);

  if (underlineMatch) {
    return <Text underline>{underlineMatch[1]}</Text>;
  }

  return stripHtmlTags(text);
}

function ChatHistory({ runs }: { runs: CompletedRun[] }) {
  if (runs.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {runs.map((run) => (
        <Box flexDirection="column" key={run.id} marginBottom={1}>
          {run.message ? <PromptBlock message={run.message} /> : null}
          <Text>
            <Text color="green">* </Text>
            <Text bold>Complete</Text>{" "}
            <Text color="gray">
              openwiki {run.command} - {run.result.model}
            </Text>
          </Text>
          <Box flexDirection="column" marginLeft={2} marginTop={1}>
            {run.log.length > 0 ? (
              run.log.map((item) => <RunLogLine item={item} key={item.id} />)
            ) : (
              <Text color="gray">No assistant output captured.</Text>
            )}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

type ChatInputProps = {
  currentModelId: string;
  currentProvider: OpenWikiProvider;
  onClear: () => void;
  onCommandRun: (
    command: Extract<OpenWikiCommand, "init" | "update">,
    message: string | null,
  ) => void;
  onModelSelect: (modelId: string) => Promise<void>;
  onProviderSelect: (provider: OpenWikiProvider) => Promise<void>;
  onSubmit: (message: string) => void;
};

function ChatInput({
  currentModelId,
  currentProvider,
  onClear,
  onCommandRun,
  onModelSelect,
  onProviderSelect,
  onSubmit,
}: ChatInputProps) {
  const [inputState, setInputState] = useState<ChatInputState>({
    cursorPosition: 0,
    value: "",
  });
  const [menuState, setMenuState] = useState<ChatInputMenuState>({
    kind: "none",
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [secretInputMode, setSecretInputMode] =
    useState<SecretInputMode | null>(null);
  const input = inputState.value;
  const cursorPosition = inputState.cursorPosition;

  useEffect(() => {
    if (secretInputMode !== null) {
      return;
    }

    setMenuState((currentState) =>
      syncMenuStateForInput(
        input,
        currentState,
        currentModelId,
        currentProvider,
      ),
    );
  }, [currentModelId, currentProvider, input, secretInputMode]);

  useInput((inputValue, key) => {
    if (isSaving) {
      return;
    }

    if (secretInputMode !== null) {
      if (isEscapeInput(inputValue, key)) {
        resetInput();
        setSecretInputMode(null);
        setNotice("Credential update canceled.");
        return;
      }

      if (key.return) {
        void saveSecretInput();
        return;
      }

      if (key.backspace || isRawBackspaceInput(inputValue)) {
        setInputState(deleteBeforeInputCursor);
        return;
      }

      if (key.delete) {
        setInputState(
          inputValue.length === 0
            ? deleteBeforeInputCursor
            : deleteAtInputCursor,
        );
        return;
      }

      if (inputValue && !key.ctrl && !key.meta) {
        setError(null);
        setNotice(null);
        setInputState((state) => applyRawInputValue(state, inputValue));
      }

      return;
    }

    if (isMenuUpInput(inputValue, key) && menuState.kind !== "none") {
      setMenuState((state) =>
        moveMenuSelection(state, -1, currentModelId, currentProvider),
      );
      return;
    }

    if (isMenuDownInput(inputValue, key) && menuState.kind !== "none") {
      setMenuState((state) =>
        moveMenuSelection(state, 1, currentModelId, currentProvider),
      );
      return;
    }

    if (key.return) {
      void submitInput();
      return;
    }

    if (isEscapeInput(inputValue, key) && menuState.kind !== "none") {
      resetInput();
      return;
    }

    if (key.leftArrow) {
      setInputState((state) => moveInputCursor(state, -1));
      return;
    }

    if (key.rightArrow) {
      setInputState((state) => moveInputCursor(state, 1));
      return;
    }

    if ((key.ctrl && inputValue === "a") || inputValue === "\u0001") {
      setInputState((state) => ({
        ...state,
        cursorPosition: 0,
      }));
      return;
    }

    if ((key.ctrl && inputValue === "e") || inputValue === "\u0005") {
      setInputState((state) => ({
        ...state,
        cursorPosition: state.value.length,
      }));
      return;
    }

    if (key.backspace || isRawBackspaceInput(inputValue)) {
      setInputState(deleteBeforeInputCursor);
      return;
    }

    if (key.delete) {
      setInputState(
        inputValue.length === 0 ? deleteBeforeInputCursor : deleteAtInputCursor,
      );
      return;
    }

    if (inputValue && !key.ctrl && !key.meta) {
      setError(null);
      setNotice(null);
      setInputState((state) => applyRawInputValue(state, inputValue));
    }
  });

  async function submitInput() {
    const message = input.trim();

    if (message.length === 0) {
      setError("Enter a follow-up message.");
      return;
    }

    if (message.startsWith("/")) {
      await submitSlashInput(message);
      return;
    }

    resetInput();
    onSubmit(message);
  }

  async function submitSlashInput(message: string) {
    if (message === "/" && menuState.kind === "commands") {
      await runSlashCommand(slashCommandOptions[menuState.selectedIndex]);
      return;
    }

    if (message === "/model" && menuState.kind === "model") {
      await selectModelMenuOption(menuState.selectedIndex);
      return;
    }

    if (message === "/provider" && menuState.kind === "provider") {
      await selectProviderMenuOption(menuState.selectedIndex);
      return;
    }

    const parsedCommand = parseSlashInput(message);

    if (parsedCommand === null) {
      setError(`Unknown command: ${message}`);
      return;
    }

    await runSlashCommand(
      parsedCommand.option,
      parsedCommand.args.length > 0 ? parsedCommand.args : null,
    );
  }

  async function runSlashCommand(
    option: SlashCommandOption | undefined,
    args: string | null = null,
  ) {
    if (!option) {
      setError("Select a slash command.");
      return;
    }

    if (option.id === "model") {
      if (args && args.length > 0) {
        await saveModelSelection(args);
        return;
      }

      setError(null);
      setNotice("Choose a model, or type /model <model-id>.");
      setInputValue("/model");
      setMenuState({
        kind: "model",
        selectedIndex: getCurrentModelOptionIndex(
          currentModelId,
          currentProvider,
        ),
      });
      return;
    }

    if (option.id === "provider") {
      if (args && args.length > 0) {
        await saveProviderSelection(args);
        return;
      }

      setError(null);
      setNotice("Choose a provider, or type /provider <provider-id>.");
      setInputValue("/provider");
      setMenuState({
        kind: "provider",
        selectedIndex: getCurrentProviderOptionIndex(currentProvider),
      });
      return;
    }

    if (option.id === "api-key") {
      if (args && args.length > 0) {
        setError(
          "Use the masked prompt for API keys; do not pass keys inline.",
        );
        return;
      }

      setError(null);
      setNotice(`Paste your ${getProviderLabel(currentProvider)} API key.`);
      setSecretInputMode({
        envKey: getProviderApiKeyEnvKey(currentProvider),
        kind: "api-key",
        label: `${getProviderLabel(currentProvider)} API key`,
        provider: currentProvider,
      });
      setInputState({ cursorPosition: 0, value: "" });
      setMenuState({ kind: "none" });
      return;
    }

    if (option.id === "langsmith-key") {
      if (args && args.length > 0) {
        setError(
          "Use the masked prompt for LangSmith keys; do not pass keys inline.",
        );
        return;
      }

      setError(null);
      setNotice("Paste your LangSmith API key, or press Enter empty to clear.");
      setSecretInputMode({
        envKey: "LANGSMITH_API_KEY",
        kind: "langsmith-key",
        label: "LangSmith API key",
      });
      setInputState({ cursorPosition: 0, value: "" });
      setMenuState({ kind: "none" });
      return;
    }

    if (option.id === "init" || option.id === "update") {
      resetInput();
      onCommandRun(option.id, args);
      return;
    }

    if (option.id === "clear") {
      resetInput();
      onClear();
      setNotice("Started a new chat thread.");
      return;
    }

    if (option.id === "help") {
      resetInput();
      setNotice(
        "Slash commands: /provider, /model, /api-key, /langsmith-key, /init, /update, /clear, /help, /exit. Use arrows to select.",
      );
      return;
    }

    resetInput();
    onSubmit("/exit");
  }

  async function selectModelMenuOption(selectedIndex: number) {
    const option = getModelMenuOptions(currentModelId, currentProvider)[
      selectedIndex
    ];

    if (!option) {
      setError("Select a model.");
      return;
    }

    if (option.kind === "custom") {
      setError(null);
      setNotice("Type a custom model ID after /model.");
      setInputValue("/model ");
      return;
    }

    await saveModelSelection(option.modelId);
  }

  async function saveModelSelection(rawModelId: string) {
    const modelId = normalizeModelId(rawModelId);

    if (!isValidModelId(modelId)) {
      setError("Enter a valid model ID.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      await onModelSelect(modelId);
      resetInput();
      setNotice(`Model switched to ${modelId}.`);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save model selection.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function selectProviderMenuOption(selectedIndex: number) {
    const provider = SELECTABLE_OPENWIKI_PROVIDERS[selectedIndex];

    if (!provider) {
      setError("Select a provider.");
      return;
    }

    await saveProviderSelection(provider);
  }

  async function saveProviderSelection(rawProvider: string) {
    const provider = normalizeProvider(rawProvider);

    if (provider === null) {
      setError(
        "Enter a valid provider: openai, openrouter, baseten, fireworks, nebius, nvidia, or anthropic.",
      );
      return;
    }

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      await onProviderSelect(provider);
      resetInput();
      setNotice(
        `Provider switched to ${getProviderLabel(provider)} with model ${getDefaultModelId(
          provider,
        )}. Ensure ${getProviderApiKeyEnvKey(provider)} is set.`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save provider selection.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function saveSecretInput() {
    if (secretInputMode === null) {
      return;
    }

    const nextValue = input.trim();
    if (secretInputMode.kind === "api-key" && nextValue.length === 0) {
      setError(`${secretInputMode.envKey} is required.`);
      return;
    }

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      if (secretInputMode.kind === "langsmith-key") {
        await saveOpenWikiEnv({
          LANGCHAIN_PROJECT: nextValue.length > 0 ? "openwiki" : "",
          LANGCHAIN_TRACING_V2: nextValue.length > 0 ? "true" : "false",
          LANGSMITH_API_KEY: nextValue,
        });
      } else {
        await saveOpenWikiEnv({
          [secretInputMode.envKey]: nextValue,
        });
      }

      const savedLabel = secretInputMode.label;
      resetInput();
      setSecretInputMode(null);
      setNotice(`${savedLabel} saved.`);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save credential.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  function resetInput() {
    setInputState({ cursorPosition: 0, value: "" });
    setMenuState({ kind: "none" });
    setError(null);
  }

  function setInputValue(value: string) {
    setInputState({
      cursorPosition: value.length,
      value,
    });
  }

  const beforeCursor = input.slice(0, cursorPosition);
  const afterCursor = input.slice(cursorPosition);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="single" borderColor="blue" paddingX={1}>
        <Text>
          <Text color="blue">{">"}</Text>{" "}
          {secretInputMode !== null ? (
            <>
              <Text color="gray">{secretInputMode.envKey}=</Text>
              <Text color="yellow">{formatSecretInputSummary(input)}</Text>
            </>
          ) : input.length > 0 ? (
            <>
              {beforeCursor}
              <InputCursor />
              {afterCursor}
            </>
          ) : (
            <>
              <InputCursor />
              <Text color="gray"> Ask a follow-up...</Text>
            </>
          )}
        </Text>
      </Box>
      <Text>
        <Text color="gray">
          {secretInputMode !== null
            ? "enter to save - esc to cancel - input is masked"
            : `enter to send - / for commands - /exit to quit - cwd ${formatCwd(
                process.cwd(),
              )}`}
        </Text>
      </Text>
      {secretInputMode !== null ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">{secretInputMode.label}</Text>
          <Text>
            Saving to <Text color="cyan">{secretInputMode.envKey}</Text>
          </Text>
          {secretInputMode.kind === "langsmith-key" ? (
            <Text color="gray">Press Enter empty to clear LangSmith.</Text>
          ) : null}
        </Box>
      ) : menuState.kind !== "none" ? (
        <SlashMenu
          currentModelId={currentModelId}
          currentProvider={currentProvider}
          input={input}
          menuState={menuState}
        />
      ) : null}
      {notice ? <Text color="green">{notice}</Text> : null}
      {isSaving ? <Text color="gray">Saving selection...</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}

type ChatInputState = {
  cursorPosition: number;
  value: string;
};

type SecretInputMode = {
  envKey: string;
  kind: "api-key" | "langsmith-key";
  label: string;
  provider?: OpenWikiProvider;
};

type ChatInputMenuState =
  | { kind: "commands"; selectedIndex: number }
  | { kind: "model"; selectedIndex: number }
  | { kind: "provider"; selectedIndex: number }
  | { kind: "none" };

type SlashCommandId =
  | "api-key"
  | "clear"
  | "exit"
  | "help"
  | "init"
  | "langsmith-key"
  | "model"
  | "provider"
  | "update";

type SlashCommandOption = {
  description: string;
  id: SlashCommandId;
  label: string;
};

type ModelMenuOption =
  | {
      kind: "model";
      label: string;
      modelId: string;
    }
  | {
      kind: "custom";
      label: string;
    };

const slashCommandOptions: SlashCommandOption[] = [
  {
    description: "Switch the model provider",
    id: "provider",
    label: "/provider",
  },
  {
    description: "Switch the current provider model",
    id: "model",
    label: "/model",
  },
  {
    description: "Set the API key for the current provider",
    id: "api-key",
    label: "/api-key",
  },
  {
    description: "Set or clear the LangSmith API key",
    id: "langsmith-key",
    label: "/langsmith-key",
  },
  {
    description: "Run an initial OpenWiki documentation pass",
    id: "init",
    label: "/init",
  },
  {
    description: "Update existing OpenWiki documentation",
    id: "update",
    label: "/update",
  },
  {
    description: "Start a fresh thread and clear chat history",
    id: "clear",
    label: "/clear",
  },
  {
    description: "Show slash command help",
    id: "help",
    label: "/help",
  },
  {
    description: "Exit OpenWiki",
    id: "exit",
    label: "/exit",
  },
];

function SlashMenu({
  currentModelId,
  currentProvider,
  input,
  menuState,
}: {
  currentModelId: string;
  currentProvider: OpenWikiProvider;
  input: string;
  menuState: Exclude<ChatInputMenuState, { kind: "none" }>;
}) {
  if (menuState.kind === "model") {
    const modelOptions = getModelMenuOptions(currentModelId, currentProvider);

    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">Models for {getProviderLabel(currentProvider)}</Text>
        {modelOptions.map((option, index) => (
          <MenuRow
            description={
              option.kind === "model" && option.modelId === currentModelId
                ? "current"
                : option.kind === "custom"
                  ? "type /model <model-id>"
                  : ""
            }
            isSelected={index === menuState.selectedIndex}
            key={option.label}
            label={option.label}
          />
        ))}
        {input.startsWith("/model ") ? (
          <Text color="gray">Press enter to save the custom model ID.</Text>
        ) : (
          <Text color="gray">Use arrows, enter to select, esc to cancel.</Text>
        )}
      </Box>
    );
  }

  if (menuState.kind === "provider") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">Providers</Text>
        {SELECTABLE_OPENWIKI_PROVIDERS.map((provider, index) => (
          <MenuRow
            description={
              provider === currentProvider
                ? "current"
                : `default model ${getDefaultModelId(provider)}`
            }
            isSelected={index === menuState.selectedIndex}
            key={provider}
            label={getProviderLabel(provider)}
          />
        ))}
        <Text color="gray">Use arrows, enter to select, esc to cancel.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">Commands</Text>
      {slashCommandOptions.map((option, index) => (
        <MenuRow
          description={option.description}
          isSelected={index === menuState.selectedIndex}
          key={option.id}
          label={option.label}
        />
      ))}
      <Text color="gray">Use arrows, enter to select, esc to cancel.</Text>
    </Box>
  );
}

function MenuRow({
  description,
  isSelected,
  label,
}: {
  description: string;
  isSelected: boolean;
  label: string;
}) {
  return (
    <Text>
      <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? ">" : " "}</Text>{" "}
      <Text bold={isSelected}>{label.padEnd(28)}</Text>
      <Text color="gray">{description}</Text>
    </Text>
  );
}

function moveInputCursor(
  state: ChatInputState,
  offset: number,
): ChatInputState {
  return {
    ...state,
    cursorPosition: clampCursorPosition(
      state.cursorPosition + offset,
      state.value,
    ),
  };
}

function deleteBeforeInputCursor(state: ChatInputState): ChatInputState {
  if (state.cursorPosition === 0) {
    return state;
  }

  return {
    cursorPosition: state.cursorPosition - 1,
    value: `${state.value.slice(0, state.cursorPosition - 1)}${state.value.slice(
      state.cursorPosition,
    )}`,
  };
}

function deleteAtInputCursor(state: ChatInputState): ChatInputState {
  if (state.cursorPosition >= state.value.length) {
    return state;
  }

  return {
    ...state,
    value: `${state.value.slice(0, state.cursorPosition)}${state.value.slice(
      state.cursorPosition + 1,
    )}`,
  };
}

function applyRawInputValue(
  state: ChatInputState,
  inputValue: string,
): ChatInputState {
  let nextState = state;

  for (let index = 0; index < inputValue.length; index += 1) {
    if (inputValue.startsWith("\u001b[D", index)) {
      nextState = moveInputCursor(nextState, -1);
      index += 2;
      continue;
    }

    if (inputValue.startsWith("\u001b[C", index)) {
      nextState = moveInputCursor(nextState, 1);
      index += 2;
      continue;
    }

    if (inputValue.startsWith("\u001b[3~", index)) {
      nextState = deleteAtInputCursor(nextState);
      index += 3;
      continue;
    }

    if (
      inputValue.startsWith("\u007f", index) ||
      inputValue.startsWith("\b", index)
    ) {
      nextState = deleteBeforeInputCursor(nextState);
      continue;
    }

    if (
      inputValue.startsWith("\u001b[A", index) ||
      inputValue.startsWith("\u001b[B", index)
    ) {
      index += 2;
      continue;
    }

    const character = inputValue[index];

    if (isControlCharacter(character)) {
      continue;
    }

    nextState = insertAtInputCursor(nextState, character);
  }

  return nextState;
}

function insertAtInputCursor(
  state: ChatInputState,
  character: string,
): ChatInputState {
  return {
    cursorPosition: state.cursorPosition + character.length,
    value: `${state.value.slice(0, state.cursorPosition)}${character}${state.value.slice(
      state.cursorPosition,
    )}`,
  };
}

function clampCursorPosition(position: number, value: string): number {
  return Math.max(0, Math.min(value.length, position));
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);

  return codePoint !== undefined && codePoint < 32;
}

function isRawBackspaceInput(inputValue: string): boolean {
  return inputValue === "\u007f" || inputValue === "\b";
}

function isEscapeInput(
  inputValue: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
): boolean {
  return key.escape || inputValue === "\u001b";
}

function syncMenuStateForInput(
  input: string,
  currentState: ChatInputMenuState,
  currentModelId: string,
  currentProvider: OpenWikiProvider,
): ChatInputMenuState {
  if (input.startsWith("/provider")) {
    const selectedIndex =
      currentState.kind === "provider"
        ? currentState.selectedIndex
        : getCurrentProviderOptionIndex(currentProvider);

    return {
      kind: "provider",
      selectedIndex: clampMenuIndex(
        selectedIndex,
        SELECTABLE_OPENWIKI_PROVIDERS.length,
      ),
    };
  }

  if (input.startsWith("/model")) {
    const selectedIndex =
      currentState.kind === "model"
        ? currentState.selectedIndex
        : getCurrentModelOptionIndex(currentModelId, currentProvider);

    return {
      kind: "model",
      selectedIndex: clampMenuIndex(
        selectedIndex,
        getModelMenuOptions(currentModelId, currentProvider).length,
      ),
    };
  }

  if (input.startsWith("/")) {
    const selectedIndex =
      currentState.kind === "commands"
        ? currentState.selectedIndex
        : getCommandOptionIndex(input);

    return {
      kind: "commands",
      selectedIndex: clampMenuIndex(selectedIndex, slashCommandOptions.length),
    };
  }

  return { kind: "none" };
}

function moveMenuSelection(
  menuState: ChatInputMenuState,
  offset: number,
  currentModelId: string,
  currentProvider: OpenWikiProvider,
): ChatInputMenuState {
  if (menuState.kind === "none") {
    return menuState;
  }

  const itemCount =
    menuState.kind === "model"
      ? getModelMenuOptions(currentModelId, currentProvider).length
      : menuState.kind === "provider"
        ? SELECTABLE_OPENWIKI_PROVIDERS.length
        : slashCommandOptions.length;

  return {
    ...menuState,
    selectedIndex: wrapMenuIndex(menuState.selectedIndex + offset, itemCount),
  };
}

function getCommandOptionIndex(input: string): number {
  const matchingIndex = slashCommandOptions.findIndex((option) =>
    option.label.startsWith(input),
  );

  return matchingIndex === -1 ? 0 : matchingIndex;
}

function getCurrentModelOptionIndex(
  currentModelId: string,
  currentProvider: OpenWikiProvider,
): number {
  const matchingIndex = getModelMenuOptions(
    currentModelId,
    currentProvider,
  ).findIndex(
    (option) => option.kind === "model" && option.modelId === currentModelId,
  );

  return matchingIndex === -1 ? 0 : matchingIndex;
}

function getCurrentProviderOptionIndex(
  currentProvider: OpenWikiProvider,
): number {
  const matchingIndex = SELECTABLE_OPENWIKI_PROVIDERS.findIndex(
    (provider) => provider === currentProvider,
  );

  return matchingIndex === -1 ? 0 : matchingIndex;
}

function getModelMenuOptions(
  currentModelId: string,
  currentProvider: OpenWikiProvider,
): ModelMenuOption[] {
  const modelIds = Array.from(
    new Set(
      [
        currentModelId,
        ...getProviderModelOptions(currentProvider).map((model) => model.id),
      ].filter(Boolean),
    ),
  );

  return [
    ...modelIds.map((modelId) => {
      const preset = getProviderModelOptions(currentProvider).find(
        (model) => model.id === modelId,
      );

      return {
        kind: "model" as const,
        label: preset ? `${preset.label} ${modelId}` : modelId,
        modelId,
      };
    }),
    {
      kind: "custom" as const,
      label: "Custom model ID",
    },
  ];
}

function parseSlashInput(
  input: string,
): { args: string; option: SlashCommandOption } | null {
  const trimmedInput = input.trim();
  const [commandName = "", ...args] = trimmedInput.split(/\s+/u);
  const option = slashCommandOptions.find(
    (commandOption) => commandOption.label === commandName,
  );

  return option ? { args: args.join(" "), option } : null;
}

function isMenuUpInput(
  inputValue: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
): boolean {
  return key.upArrow || inputValue === "\u001b[A";
}

function isMenuDownInput(
  inputValue: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
): boolean {
  return key.downArrow || inputValue === "\u001b[B";
}

function clampMenuIndex(index: number, itemCount: number): number {
  return Math.max(0, Math.min(Math.max(0, itemCount - 1), index));
}

function wrapMenuIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }

  return ((index % itemCount) + itemCount) % itemCount;
}

function InputCursor() {
  return <Text color="cyan">|</Text>;
}

function formatSecretInputSummary(value: string): string {
  return value.length === 0 ? "[empty]" : `[hidden, ${value.length} chars]`;
}

function PromptBlock({ message }: { message: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text backgroundColor="gray" wrap="wrap">
        {" "}
        <Text color="cyan">{">"}</Text> {message}
      </Text>
    </Box>
  );
}

function updateRunningCredentialDiagnostics(
  state: RunState,
  credentialDiagnostics: CredentialDiagnostic[],
  credentialDiagnosticsRef: React.MutableRefObject<
    CredentialDiagnostic[] | undefined
  >,
): RunState {
  credentialDiagnosticsRef.current = credentialDiagnostics;

  return state.status === "running"
    ? {
        ...state,
        credentialDiagnostics,
      }
    : state;
}

function appendRunLogEvent(
  log: RunLogItem[],
  event: OpenWikiRunEvent,
  nextLogId: React.MutableRefObject<number>,
): RunLogItem[] {
  if (event.type === "text" && event.source === "subgraph") {
    return log;
  }

  if (event.type === "text" && event.text.length === 0) {
    return log;
  }

  if (event.type === "tool_start") {
    return appendToolStartLogItem(log, event, nextLogId);
  }

  if (event.type === "tool_end") {
    return completeToolLogItem(log, event);
  }

  const nextLog = [...log];
  const content = event.type === "text" ? event.text : event.message;
  const previous = nextLog.at(-1);

  if (event.type === "text" && previous?.type === "text") {
    nextLog[nextLog.length - 1] = {
      ...previous,
      content: `${previous.content}${content}`,
    };
  } else {
    nextLog.push({
      id: nextLogId.current,
      type: event.type,
      content,
    });
    nextLogId.current += 1;
  }

  return nextLog;
}

function appendToolStartLogItem(
  log: RunLogItem[],
  event: Extract<OpenWikiRunEvent, { type: "tool_start" }>,
  nextLogId: React.MutableRefObject<number>,
): RunLogItem[] {
  const toolDisplay = createToolDisplay(event);
  const nextLog = [...log];
  const previous = nextLog.at(-1);

  if (previous?.type === "tool") {
    const actionCount = (previous.actionCount ?? 1) + 1;
    const errorCount = previous.errorCount ?? 0;
    const latestDoneContent = toolDisplay.done;

    nextLog[nextLog.length - 1] = {
      ...previous,
      actionCount,
      activeToolCallIds: [...getActiveToolCallIds(previous), event.id],
      call: toolDisplay.showDetail ? event.call : undefined,
      content: formatToolGroupRunning(actionCount, toolDisplay.running),
      doneContent: formatToolGroupDone(
        actionCount,
        errorCount,
        latestDoneContent,
      ),
      errorCount,
      latestDoneContent,
      status: "running",
      toolCallId: event.id,
      toolName: event.name,
    };

    return nextLog;
  }

  return [
    ...log,
    {
      actionCount: 1,
      activeToolCallIds: [event.id],
      call: toolDisplay.showDetail ? event.call : undefined,
      content: toolDisplay.running,
      doneContent: toolDisplay.done,
      errorCount: 0,
      id: nextLogId.current++,
      latestDoneContent: toolDisplay.done,
      status: "running",
      toolCallId: event.id,
      toolName: event.name,
      type: "tool",
    },
  ];
}

function completeToolLogItem(
  log: RunLogItem[],
  event: Extract<OpenWikiRunEvent, { type: "tool_end" }>,
): RunLogItem[] {
  const matchingIndex = findLastToolLogItemIndex(log, event.id);

  if (matchingIndex === -1) {
    return log;
  }

  return log.map((item, index) =>
    index === matchingIndex ? completeToolGroupItem(item, event) : item,
  );
}

function completeToolGroupItem(
  item: RunLogItem,
  event: Extract<OpenWikiRunEvent, { type: "tool_end" }>,
): RunLogItem {
  const actionCount = item.actionCount ?? 1;
  const activeToolCallIds = getActiveToolCallIds(item).filter(
    (id) => id !== event.id,
  );
  const errorCount =
    (item.errorCount ?? 0) + (event.status === "error" ? 1 : 0);
  const latestDoneContent = item.latestDoneContent ?? item.doneContent;

  if (activeToolCallIds.length > 0) {
    return {
      ...item,
      activeToolCallIds,
      call: undefined,
      content: formatToolGroupRunning(actionCount, null),
      doneContent: formatToolGroupDone(
        actionCount,
        errorCount,
        latestDoneContent,
      ),
      errorCount,
      status: "running",
    };
  }

  return {
    ...item,
    activeToolCallIds,
    call: undefined,
    content: formatToolGroupDone(actionCount, errorCount, latestDoneContent),
    doneContent: formatToolGroupDone(
      actionCount,
      errorCount,
      latestDoneContent,
    ),
    errorCount,
    status: errorCount > 0 ? "error" : "done",
  };
}

function findLastToolLogItemIndex(
  log: RunLogItem[],
  toolCallId: string,
): number {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const item = log[index];

    if (
      item.type === "tool" &&
      item.status === "running" &&
      getActiveToolCallIds(item).includes(toolCallId)
    ) {
      return index;
    }
  }

  return -1;
}

function getActiveToolCallIds(item: RunLogItem): string[] {
  if (item.activeToolCallIds) {
    return item.activeToolCallIds;
  }

  if (item.status === "running" && item.toolCallId) {
    return [item.toolCallId];
  }

  return [];
}

function formatToolGroupRunning(
  actionCount: number,
  currentAction: string | null,
): string {
  if (actionCount <= 1) {
    return currentAction ?? "Running 1 action";
  }

  if (currentAction) {
    return `Running ${formatCount(actionCount, "action", "actions")}: ${currentAction}`;
  }

  return `Running ${formatCount(actionCount, "action", "actions")}`;
}

function formatToolGroupDone(
  actionCount: number,
  errorCount: number,
  latestDoneContent?: string,
): string {
  if (actionCount <= 1 && errorCount === 0) {
    return latestDoneContent ?? "Ran 1 action";
  }

  if (errorCount > 0) {
    return `Ran ${formatCount(actionCount, "action", "actions")} with ${formatCount(
      errorCount,
      "failure",
      "failures",
    )}`;
  }

  return `Ran ${formatCount(actionCount, "action", "actions")}`;
}

type ToolDisplay = {
  done: string;
  running: string;
  showDetail: boolean;
};

function createToolDisplay(
  event: Extract<OpenWikiRunEvent, { type: "tool_start" }>,
): ToolDisplay {
  const input = parseToolInput(event.input);
  const variantIndex = pickVariantIndex(
    `${event.id}:${event.name}:${event.call}`,
  );

  switch (event.name) {
    case "read_file": {
      const count = countToolTargets(input, ["path", "paths", "file", "files"]);
      return pickToolDisplay(
        variantIndex,
        [
          `Reading ${formatCount(count, "file", "files")}`,
          `Examining ${formatCount(count, "file", "files")}`,
          `Taking a look at ${formatCount(count, "file", "files")}`,
        ],
        [
          `Read ${formatCount(count, "file", "files")}`,
          `Examined ${formatCount(count, "file", "files")}`,
          `Looked at ${formatCount(count, "file", "files")}`,
        ],
      );
    }
    case "edit_file": {
      const count = countToolTargets(input, ["path", "paths", "file", "files"]);
      return pickToolDisplay(
        variantIndex,
        [
          `Editing ${formatCount(count, "file", "files")}`,
          `Updating ${formatCount(count, "file", "files")}`,
          `Applying changes to ${formatCount(count, "file", "files")}`,
        ],
        [
          `Edited ${formatCount(count, "file", "files")}`,
          `Updated ${formatCount(count, "file", "files")}`,
          `Applied changes to ${formatCount(count, "file", "files")}`,
        ],
        false,
      );
    }
    case "write_file": {
      const count = countToolTargets(input, ["path", "paths", "file", "files"]);
      return pickToolDisplay(
        variantIndex,
        [
          `Writing ${formatCount(count, "file", "files")}`,
          `Creating ${formatCount(count, "file", "files")}`,
          `Saving ${formatCount(count, "file", "files")}`,
        ],
        [
          `Wrote ${formatCount(count, "file", "files")}`,
          `Created ${formatCount(count, "file", "files")}`,
          `Saved ${formatCount(count, "file", "files")}`,
        ],
        false,
      );
    }
    case "ls":
      return pickToolDisplay(
        variantIndex,
        ["Listing files", "Scanning a directory", "Checking the file tree"],
        ["Listed files", "Scanned a directory", "Checked the file tree"],
      );
    case "glob":
      return pickToolDisplay(
        variantIndex,
        [
          "Finding matching files",
          "Searching file paths",
          "Scanning for matches",
        ],
        ["Found matching files", "Searched file paths", "Scanned for matches"],
      );
    case "grep":
      return pickToolDisplay(
        variantIndex,
        [
          "Searching file contents",
          "Grepping the codebase",
          "Looking for matches",
        ],
        [
          "Searched file contents",
          "Grepped the codebase",
          "Looked for matches",
        ],
      );
    case "write_todos": {
      const count = countTodoItems(input);
      return pickToolDisplay(
        variantIndex,
        [
          `Updating ${formatCount(count, "todo", "todos")}`,
          `Organizing ${formatCount(count, "todo", "todos")}`,
          `Refreshing ${formatCount(count, "todo", "todos")}`,
        ],
        [
          `Updated ${formatCount(count, "todo", "todos")}`,
          `Organized ${formatCount(count, "todo", "todos")}`,
          `Refreshed ${formatCount(count, "todo", "todos")}`,
        ],
      );
    }
    case "task": {
      const count = countToolTargets(input, [
        "tasks",
        "subagents",
        "agents",
        "items",
      ]);
      return pickToolDisplay(
        variantIndex,
        [
          `Spinning up ${formatCount(count, "subagent", "subagents")}`,
          `Starting ${formatCount(count, "subagent", "subagents")}`,
          `Delegating to ${formatCount(count, "subagent", "subagents")}`,
        ],
        [
          `Finished ${formatCount(count, "subagent", "subagents")}`,
          `Completed ${formatCount(count, "subagent", "subagents")}`,
          `Wrapped up ${formatCount(count, "subagent", "subagents")}`,
        ],
      );
    }
    default:
      return {
        done: event.call,
        running: event.call,
        showDetail: false,
      };
  }
}

function pickToolDisplay(
  variantIndex: number,
  running: string[],
  done: string[],
  showDetail = true,
): ToolDisplay {
  const index = variantIndex % Math.min(running.length, done.length);

  return {
    done: done[index],
    running: running[index],
    showDetail,
  };
}

function parseToolInput(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }

  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function countToolTargets(input: unknown, keys: string[]): number {
  if (Array.isArray(input)) {
    return Math.max(input.length, 1);
  }

  if (!isRecord(input)) {
    return 1;
  }

  for (const key of keys) {
    const value = input[key];

    if (Array.isArray(value)) {
      return Math.max(value.length, 1);
    }

    if (typeof value === "string" && value.trim().length > 0) {
      return 1;
    }
  }

  return 1;
}

function countTodoItems(input: unknown): number {
  if (!isRecord(input)) {
    return 1;
  }

  const todos = input.todos ?? input.items;

  return Array.isArray(todos) ? Math.max(todos.length, 1) : 1;
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function pickVariantIndex(seed: string): number {
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function isExitMessage(message: string): boolean {
  const normalizedMessage = message.trim().toLowerCase();

  return normalizedMessage === "/exit";
}

function truncateLogOutput(content: string, label: string): string {
  const terminalColumns = process.stdout.columns ?? 80;
  const availableColumns = Math.max(24, terminalColumns - label.length - 7);

  return truncateToDisplayLines(content, 2, availableColumns);
}

function truncateToDisplayLines(
  content: string,
  maxLines: number,
  maxColumns: number,
): string {
  const normalizedContent = content.replace(/\s+/gu, " ").trim();

  if (normalizedContent.length <= maxColumns) {
    return normalizedContent;
  }

  const lines: string[] = [];
  let remaining = normalizedContent;

  while (remaining.length > 0 && lines.length < maxLines) {
    lines.push(remaining.slice(0, maxColumns));
    remaining = remaining.slice(maxColumns);
  }

  if (remaining.length > 0 && lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    lines[lines.length - 1] =
      lastLine.length > 3 ? `${lastLine.slice(0, -3)}...` : "...";
  }

  return lines.join("\n");
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME;

  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }

  return cwd;
}

function isDebugMode(): boolean {
  return process.env.OPENWIKI_DEBUG === "1";
}

function shouldShowCredentialDiagnostics(): boolean {
  return isDebugMode() || process.env.OPENWIKI_DEBUG_CREDENTIALS === "1";
}

function getDisplayModelId(modelId: string | null): string {
  return (
    modelId ??
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
    getDefaultModelId(resolveConfiguredProvider())
  );
}

function getErrorDiagnostics(error: unknown): ErrorDiagnostic[] {
  const diagnostics: ErrorDiagnostic[] = [];
  const debugMode = isDebugMode();

  if (debugMode && error instanceof Error) {
    diagnostics.push(
      { label: "name", value: error.name },
      { label: "message", value: sanitizeDiagnosticText(error.message) },
    );

    const messageStatus = error.message.match(/\b([45]\d{2})\b/)?.[1];

    if (messageStatus) {
      diagnostics.push({
        label: "httpStatusFromMessage",
        value: messageStatus,
      });
    }
  }

  if (!isRecord(error)) {
    return diagnostics;
  }

  addOpenRouterMetadataDiagnostics(diagnostics, error, "");
  addAttachedDebugDiagnostics(diagnostics, error, "");

  if (debugMode) {
    addSafeObjectDiagnostics(diagnostics, error, "");
    addSafeNestedDiagnostics(diagnostics, error, "cause");
    addSafeNestedDiagnostics(diagnostics, error, "error");
    addSafeNestedDiagnostics(diagnostics, error, "response");
  }

  return dedupeDiagnostics(diagnostics);
}

function addSafeNestedDiagnostics(
  diagnostics: ErrorDiagnostic[],
  value: Record<string, unknown>,
  key: string,
): void {
  const nested = value[key];

  if (!isRecord(nested)) {
    return;
  }

  addSafeObjectDiagnostics(diagnostics, nested, key);
  addOpenRouterMetadataDiagnostics(diagnostics, nested, key);
  addAttachedDebugDiagnostics(diagnostics, nested, key);
}

function addSafeObjectDiagnostics(
  diagnostics: ErrorDiagnostic[],
  value: Record<string, unknown>,
  prefix: string,
): void {
  for (const key of [
    "status",
    "statusCode",
    "statusText",
    "code",
    "type",
    "param",
    "request_id",
    "requestID",
    "lc_error_code",
  ]) {
    const property = value[key];

    if (isDiagnosticValue(property)) {
      diagnostics.push({
        label: prefix ? `${prefix}.${key}` : key,
        value: sanitizeDiagnosticText(String(property)),
      });
    }
  }

  addSafeHeaderDiagnostics(diagnostics, value.headers, prefix);
}

function addAttachedDebugDiagnostics(
  diagnostics: ErrorDiagnostic[],
  value: Record<string, unknown>,
  prefix: string,
): void {
  const debugValue = value.openRouterDebug;

  if (debugValue === undefined || debugValue === null) {
    return;
  }

  diagnostics.push({
    label: prefix ? `${prefix}.openRouterDebug` : "openRouterDebug",
    value: formatDiagnosticMetadataValue(debugValue),
  });
}

function addOpenRouterMetadataDiagnostics(
  diagnostics: ErrorDiagnostic[],
  value: Record<string, unknown>,
  prefix: string,
): void {
  const metadata = value.metadata;

  if (!isRecord(metadata)) {
    return;
  }

  for (const key of ["provider_name", "is_byok", "finish_reason"]) {
    const property = metadata[key];

    if (isDiagnosticValue(property)) {
      diagnostics.push({
        label: prefix ? `${prefix}.metadata.${key}` : `metadata.${key}`,
        value: sanitizeDiagnosticText(String(property)),
      });
    }
  }

  addMetadataValueDiagnostic(diagnostics, metadata, "raw", prefix);
  addPreviousErrorDiagnostics(diagnostics, metadata.previous_errors, prefix);
}

function addMetadataValueDiagnostic(
  diagnostics: ErrorDiagnostic[],
  metadata: Record<string, unknown>,
  key: string,
  prefix: string,
): void {
  const value = metadata[key];

  if (value === undefined || value === null) {
    return;
  }

  diagnostics.push({
    label: prefix ? `${prefix}.metadata.${key}` : `metadata.${key}`,
    value: formatDiagnosticMetadataValue(value),
  });
}

function addPreviousErrorDiagnostics(
  diagnostics: ErrorDiagnostic[],
  previousErrors: unknown,
  prefix: string,
): void {
  if (!Array.isArray(previousErrors)) {
    return;
  }

  previousErrors.slice(0, 5).forEach((previousError, index) => {
    diagnostics.push({
      label: prefix
        ? `${prefix}.metadata.previous_errors.${index}`
        : `metadata.previous_errors.${index}`,
      value: formatDiagnosticMetadataValue(previousError),
    });
  });

  if (previousErrors.length > 5) {
    diagnostics.push({
      label: prefix
        ? `${prefix}.metadata.previous_errors.more`
        : "metadata.previous_errors.more",
      value: `${previousErrors.length - 5} more previous provider errors`,
    });
  }
}

function formatDiagnosticMetadataValue(value: unknown): string {
  if (isDiagnosticValue(value)) {
    return truncateDiagnosticValue(sanitizeDiagnosticText(String(value)));
  }

  return truncateDiagnosticValue(sanitizeDiagnosticText(safeStringify(value)));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, createDiagnosticJsonReplacer(), 2);
  } catch {
    return String(value);
  }
}

function createDiagnosticJsonReplacer() {
  const seen = new WeakSet<object>();

  return (key: string, value: unknown) => {
    if (isSecretLikeKey(key)) {
      return "[REDACTED]";
    }

    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }

      seen.add(value);
    }

    return value;
  };
}

function truncateDiagnosticValue(value: string): string {
  const maxLength = 2_000;
  const normalizedValue = value.trim();

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxLength - 3)}...`;
}

function addSafeHeaderDiagnostics(
  diagnostics: ErrorDiagnostic[],
  headers: unknown,
  prefix: string,
): void {
  if (!isRecord(headers)) {
    return;
  }

  for (const key of [
    "x-request-id",
    "request-id",
    "openai-processing-ms",
    "cf-ray",
  ]) {
    const value = getHeaderValue(headers, key);

    if (isDiagnosticValue(value)) {
      diagnostics.push({
        label: prefix ? `${prefix}.header.${key}` : `header.${key}`,
        value: sanitizeDiagnosticText(String(value)),
      });
    }
  }
}

function getHeaderValue(
  headers: Record<string, unknown>,
  key: string,
): unknown {
  if (key in headers) {
    return headers[key];
  }

  const matchingKey = Object.keys(headers).find(
    (headerKey) => headerKey.toLowerCase() === key,
  );

  return matchingKey ? headers[matchingKey] : undefined;
}

function dedupeDiagnostics(diagnostics: ErrorDiagnostic[]): ErrorDiagnostic[] {
  const seen = new Set<string>();
  const deduped: ErrorDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.label}:${diagnostic.value}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(diagnostic);
  }

  return deduped;
}

function isDiagnosticValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeHeaderValue(value: string, maxLength = 80): string {
  const compactValue = stripControlCharacters(value)
    .replace(/[^\S\n]+/gu, " ")
    .replace(/[\r\n\t]/gu, " ")
    .trim();

  if (compactValue.length <= maxLength) {
    return compactValue;
  }

  return `${compactValue.slice(0, Math.max(0, maxLength - 3))}...`;
}

function stripControlCharacters(value: string): string {
  let sanitized = "";

  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (
      codePoint === undefined ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159)
    ) {
      sanitized += " ";
      continue;
    }

    sanitized += character;
  }

  return sanitized;
}

type PanelProps = {
  title: string;
  children: React.ReactNode;
};

function Panel({ title, children }: PanelProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="cyan"># </Text>
        <Text bold>{title}</Text>
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        {children}
      </Box>
    </Box>
  );
}

type RowsProps = {
  rows: HelpRow[];
};

function Rows({ rows }: RowsProps) {
  const labelWidth = Math.max(...rows.map((row) => row.label.length));

  return (
    <>
      {rows.map((row) => (
        <Text key={row.label}>
          {"  "}
          {row.label.padEnd(labelWidth)}
          {"  "}
          {row.description}
        </Text>
      ))}
    </>
  );
}

const argv = process.argv.slice(2);
const parsedCommand = parseCommand(argv);

if (
  (parsedCommand.kind === "run" && !parsedCommand.dryRun) ||
  parsedCommand.kind === "auth" ||
  parsedCommand.kind === "cron" ||
  parsedCommand.kind === "ingest" ||
  parsedCommand.kind === "ngrok"
) {
  await loadOpenWikiEnv();
}

const command = await resolveStartupCommand(parsedCommand, {
  cwd: process.cwd(),
  isStdinTTY: Boolean(process.stdin.isTTY),
});

if (command.kind === "auth") {
  await runAuthCommand(command);
} else if (command.kind === "ngrok") {
  await runNgrokCommand(command);
} else if (command.kind === "cron") {
  await runCronCommand(command);
} else if (command.kind === "ingest") {
  await runIngestCommand(command);
} else if (shouldPrintStartupError(argv, parsedCommand, command)) {
  process.stderr.write(`${command.message}\n`);
  process.exitCode = command.exitCode;
} else if (shouldRunNonInteractively(command, process.stdin.isTTY === true)) {
  await runPrintCommand(command);
} else {
  render(<App command={command} />);
}

async function runNgrokCommand(
  command: Extract<CliCommand, { kind: "ngrok" }>,
): Promise<void> {
  try {
    await startNgrokTunnel({
      port: command.port,
      url: command.url,
    });
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

async function runCronCommand(
  command: Extract<CliCommand, { kind: "cron" }>,
): Promise<void> {
  try {
    const config = await readOpenWikiOnboardingConfig();

    if (command.action !== "list") {
      if (!command.target) {
        throw new Error(`Target is required for cron ${command.action}.`);
      }

      const result =
        command.action === "pause"
          ? await pauseConnectorSchedules(config, command.target)
          : command.action === "resume"
            ? await resumeConnectorSchedules({
                config,
                cwd: process.cwd(),
                target: command.target,
              })
            : await deleteConnectorSchedules(config, command.target);

      await saveOpenWikiOnboardingConfig(result.config);
      process.stdout.write(
        formatScheduleMutationResult(command.action, result),
      );
      await printCronSchedules(result.config);
      process.exitCode = 0;
      return;
    }

    await printCronSchedules(config);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

async function printCronSchedules(
  config: Awaited<ReturnType<typeof readOpenWikiOnboardingConfig>>,
): Promise<void> {
  const schedules = await listConnectorSchedules(config);
  const powerSchedule = getSavedPowerScheduleStatus(config);

  process.stdout.write(formatScheduleHeader(schedules.length));
  process.stdout.write(formatPowerScheduleStatus(powerSchedule));

  if (schedules.length === 0) {
    process.stdout.write("No connector schedules are configured.\n");
    return;
  }

  for (const schedule of schedules) {
    process.stdout.write(formatScheduleStatus(schedule));
  }
}

function formatScheduleMutationResult(
  action: "delete" | "pause" | "resume",
  result: ScheduleMutationResult,
): string {
  const actionLabel =
    action === "delete" ? "Deleted" : action === "pause" ? "Paused" : "Resumed";
  const changed =
    result.connectorIds.length > 0 ? result.connectorIds.join(", ") : "none";
  const skipped =
    result.skippedConnectorIds.length > 0
      ? result.skippedConnectorIds.join(", ")
      : "none";
  const rows = [
    [`${actionLabel}`, changed],
    ["Skipped", skipped],
  ];

  if (result.powerSchedule) {
    rows.push([
      "Mac wake",
      result.powerSchedule.enabled ? "configured" : "not configured",
    ]);
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const body = rows
    .map(([label, value]) => `  ${label.padEnd(labelWidth)} : ${value}`)
    .join("\n");
  const warnings =
    result.warnings.length > 0
      ? `\n${result.warnings.map((warning) => `  Warning : ${warning}`).join("\n")}`
      : "";

  return ["", "Cron update", "-----------", body + warnings, ""].join("\n");
}

function formatScheduleHeader(scheduleCount: number): string {
  const title = "OpenWiki Schedules";
  const summary =
    scheduleCount === 1
      ? "1 connector schedule configured"
      : `${scheduleCount} connector schedules configured`;

  return [
    "",
    "=".repeat(title.length),
    title,
    "=".repeat(title.length),
    summary,
    "",
  ].join("\n");
}

function formatPowerScheduleStatus(
  schedule: PowerScheduleStatus | null,
): string {
  const divider = "-".repeat(22);

  if (!schedule) {
    return [
      divider,
      "Mac Wake Window",
      divider,
      "  Status : not configured",
      "",
      "",
    ].join("\n");
  }

  const rows = [
    ["Status", schedule.enabled ? "configured" : "disabled"],
    ["Days", schedule.days || "unknown"],
    ["Wake", schedule.wakeTime || "unknown"],
    ["Sleep", schedule.sleepTime || "unknown"],
    ["Updated", schedule.updatedAt],
  ];

  if (schedule.warning) {
    rows.push(["Warning", schedule.warning]);
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const body = rows
    .map(([label, value]) => `  ${label.padEnd(labelWidth)} : ${value}`)
    .join("\n");

  return [divider, "Mac Wake Window", divider, body, "", ""].join("\n");
}

function formatScheduleStatus(schedule: ConnectorScheduleStatus): string {
  const launchdStatus =
    schedule.pausedAt !== undefined
      ? "paused"
      : schedule.launchAgentPath === undefined
        ? "not installed"
        : schedule.launchAgentLoaded
          ? "loaded"
          : schedule.launchAgentPlistExists
            ? "plist exists, not loaded"
            : "plist missing";
  const rows = [
    ["Schedule", schedule.description],
    ["Cron", schedule.expression],
    ["Launchd", launchdStatus],
    ["Updated", schedule.updatedAt],
  ];

  if (schedule.pausedAt) {
    rows.push(["Paused", schedule.pausedAt]);
  }

  if (schedule.launchAgentPath) {
    rows.push(["Plist", schedule.launchAgentPath]);
  }

  if (schedule.warning) {
    rows.push(["Warning", schedule.warning]);
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const body = rows
    .map(([label, value]) => `  ${label.padEnd(labelWidth)} : ${value}`)
    .join("\n");
  const scheduleLabel = schedule.displayName ?? schedule.sourceInstanceId;
  const divider = "-".repeat(Math.max(18, scheduleLabel.length + 10));

  return [
    divider,
    `Source : ${scheduleLabel}`,
    ...(schedule.connectorId ? [`Connector : ${schedule.connectorId}`] : []),
    divider,
    body,
    "",
  ].join("\n");
}

async function runIngestCommand(
  command: Extract<CliCommand, { kind: "ingest" }>,
): Promise<void> {
  try {
    const result = await runOpenWikiIngestion(process.cwd(), {
      debug: isDebugMode(),
      modelId: command.modelId,
      scheduledOnly: command.scheduledOnly,
      target: command.target,
      onEvent: (event) => {
        if (event.type === "text" && event.source !== "subgraph") {
          process.stdout.write(event.text);
        }
      },
    });

    process.stdout.write("\nIngestion summary\n");
    for (const sourceResult of result.results) {
      process.stdout.write(
        `- ${sourceResult.displayName}: ${sourceResult.status}; ${sourceResult.rawFiles.length} raw file(s)\n`,
      );
    }

    process.exitCode = result.results.some(
      (sourceResult) => sourceResult.status === "error",
    )
      ? 1
      : 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    writePrintErrorDiagnostics(error);
    process.exitCode = 1;
  }
}

async function runAuthCommand(
  command: Extract<CliCommand, { kind: "auth" }>,
): Promise<void> {
  try {
    if (command.action === "list") {
      process.stdout.write(`${formatAuthProviderList()}\n`);
      process.exitCode = 0;
      return;
    }

    if (command.provider === null) {
      throw new Error("Auth provider is required.");
    }

    if (command.action === "configure") {
      const result = await configureAuthProvider(command.provider, {
        force: command.force,
      });
      process.stdout.write(
        `${result.status === "exists" ? "Config already exists" : `Config ${result.status}`}: ${result.configPath}\n`,
      );
      for (const nextStep of result.nextSteps) {
        process.stdout.write(`- ${nextStep}\n`);
      }
      process.exitCode = 0;
      return;
    }

    if (command.action === "tools") {
      const result = await listAuthProviderTools(command.provider);
      process.stdout.write(
        `Tools for ${result.provider} (${result.configPath})\n`,
      );
      process.stdout.write(`Wrote discovery: ${result.rawFile}\n`);
      process.stdout.write(`${JSON.stringify(result.tools, null, 2)}\n`);
      process.exitCode = 0;
      return;
    }

    const result = await runOAuthAuth(command.provider);
    process.stdout.write(
      `Saved ${result.provider} auth values: ${result.savedEnvKeys.join(", ")}\n`,
    );
    const configureResult = await configureAuthProvider(command.provider, {
      force: command.force,
    });
    process.stdout.write(
      `${configureResult.status === "exists" ? "Config already exists" : `Config ${configureResult.status}`}: ${configureResult.configPath}\n`,
    );
    for (const nextStep of configureResult.nextSteps) {
      process.stdout.write(`- ${nextStep}\n`);
    }

    if (shouldDiscoverToolsAfterAuth(command.provider)) {
      try {
        const toolsResult = await listAuthProviderTools(command.provider);
        process.stdout.write(
          `Discovered ${toolsResult.tools.length} MCP tool(s); wrote ${toolsResult.rawFile}\n`,
        );
        const toolNames = toolsResult.tools
          .map((tool) => tool.name)
          .slice(0, 20);
        if (toolNames.length > 0) {
          process.stdout.write(`Tools: ${toolNames.join(", ")}\n`);
        }
      } catch (error) {
        process.stdout.write(
          `MCP tool discovery skipped: ${getErrorMessage(error)}\n`,
        );
      }
    }
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

function argvRequestsPrint(argv: string[]): boolean {
  return argv.some((arg) => arg === "-p" || arg === "--print");
}

function shouldPrintStartupError(
  argv: string[],
  parsedCommand: CliCommand,
  command: CliCommand,
): command is Extract<CliCommand, { kind: "error" }> {
  return (
    command.kind === "error" &&
    (argvRequestsPrint(argv) ||
      !process.stdin.isTTY ||
      (parsedCommand.kind === "run" && parsedCommand.shouldStart))
  );
}

function getRunModeCwd(
  mode: OpenWikiRunMode,
  codeRuntimeCwd = process.cwd(),
): string {
  return mode === "code" ? codeRuntimeCwd : openWikiLocalWikiDir;
}

function getRunModeOutputMode(mode: OpenWikiRunMode): OpenWikiOutputMode {
  return mode === "code" ? "repository" : "local-wiki";
}

function shouldAutoExitStartupRun(command: CliCommand): boolean {
  return (
    command.kind === "run" &&
    !command.dryRun &&
    !command.print &&
    command.shouldStart &&
    (command.command === "init" || command.command === "update")
  );
}

async function runPrintCommand(
  command: Extract<CliCommand, { kind: "run" }>,
): Promise<void> {
  try {
    const output: string[] = [];

    const runtimeCwd = getRunModeCwd(command.mode);
    const runtimeOutputMode = getRunModeOutputMode(command.mode);

    if (command.mode === "code") {
      await ensureCodeModeRepoSetup(runtimeCwd);
    }

    await runOpenWikiAgent(command.command, runtimeCwd, {
      debug: isDebugMode(),
      isFollowup: command.command === "chat",
      modelId: command.modelId,
      outputMode: runtimeOutputMode,
      threadId: createOpenWikiThreadId(runtimeCwd),
      userMessage: command.userMessage,
      onEvent: (event) => {
        if (event.type === "text" && event.source !== "subgraph") {
          output.push(event.text);
        }
      },
    });

    const text = output.join("").trim();

    if (text.length > 0) {
      process.stdout.write(`${text}\n`);
    }

    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    writePrintErrorDiagnostics(error);
    process.exitCode = 1;
  }
}

function writePrintErrorDiagnostics(error: unknown): void {
  const diagnostics = getErrorDiagnostics(error);

  if (diagnostics.length === 0) {
    return;
  }

  process.stderr.write("\nError Diagnostics\n");

  for (const diagnostic of diagnostics) {
    process.stderr.write(`${diagnostic.label}: ${diagnostic.value}\n`);
  }
}
