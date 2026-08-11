import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { OpenWikiCommand } from "../../agent/types.js";
import type { CredentialDiagnostic } from "../../config/env.js";
import type { OpenWikiIngestionResult } from "../../ingestion/ingestion.js";
import { getSpinnerFrame, truncateLogOutput } from "../format.js";
import { getActiveRunningToolLogId } from "../run-log/reducer.js";
import type { RunLogItem } from "../run-log/types.js";
import { Header } from "./header.js";
import { MarkdownText } from "./markdown.js";
import { CredentialDiagnosticsPanel } from "./panels.js";
import { Panel, PromptBlock, StatusLine } from "./primitives.js";

/**
 * A per-source summary of an ingestion run, one status line per source.
 */
export function IngestionSummary({
  result,
}: {
  result: OpenWikiIngestionResult;
}) {
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

/**
 * Props for the live/completed agent run view.
 */
interface RunViewProps {
  command: OpenWikiCommand;
  credentialDiagnostics?: CredentialDiagnostic[];
  log: RunLogItem[];

  /**
   * @default false Render as a finished run (no spinner) instead of a live one.
   */
  done?: boolean;

  /**
   * @default null The echoed user prompt to show above the log, if any.
   */
  message?: string | null;

  /**
   * @default null Explicit model id for the header, falling back to env/default.
   */
  modelId?: string | null;
}

/**
 * The live agent run view: a compact header, the echoed prompt, and the
 * streaming run log with an animated spinner while a tool is running.
 */
export function RunView({
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

/**
 * Props for a single run-log line.
 */
interface RunLogLineProps {
  /**
   * @default null Id of the currently-active running tool, so this line can
   * show a spinner and its call detail when it is the active one.
   */
  activeRunningToolId?: number | null;

  /**
   * @default 0 Spinner animation frame for the active running tool.
   */
  animationFrame?: number;

  item: RunLogItem;
}

/**
 * Renders one run-log line: a running/error/done tool line, a debug line, or an
 * assistant message rendered as markdown.
 */
export function RunLogLine({
  activeRunningToolId = null,
  animationFrame = 0,
  item,
}: RunLogLineProps) {
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
