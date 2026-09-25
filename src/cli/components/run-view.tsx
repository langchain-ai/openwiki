import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { OpenWikiCommand } from "../../agent/types.js";
import type { CredentialDiagnostic } from "../../config/env.js";
import type { OpenWikiIngestionResult } from "../../ingestion/ingestion.js";
import { formatCount } from "../format.js";
import {
  buildActivityTreeLines,
  buildExplorationTreeLines,
} from "../run-log/activity.js";
import {
  findRepositoryProgress,
  formatRepositoryProgress,
} from "../run-log/progress.js";
import {
  findRunSummary,
  formatCompletedRunCounts,
  formatRunCompletionTitle,
} from "../run-log/summary.js";
import type {
  RunActivityLogItem,
  RunDebugLogItem,
  RunLogItem,
} from "../run-log/types.js";
import { Header } from "./header.js";
import { MarkdownText } from "./markdown.js";
import { CredentialDiagnosticsPanel } from "./panels.js";
import { Panel, PromptBlock, StatusLine } from "./primitives.js";

const RUN_SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const RUN_SPINNER_INTERVAL_MS = 600;
const MAX_COMPLETED_PATHS = 5;
const DEFAULT_TERMINAL_ROWS = 24;
const EXPLORATION_VIEWPORT_RESERVED_ROWS = 20;
const MAX_EXPLORATION_VIEWPORT_LINES = 14;
const MIN_EXPLORATION_VIEWPORT_LINES = 3;

/**
 * Props for the per-source ingestion summary.
 */
interface IngestionSummaryProps {
  /**
   * Settled ingestion result containing one entry per configured source.
   */
  result: OpenWikiIngestionResult;
}

/**
 * A per-source summary of an ingestion run, one status line per source.
 */
export function IngestionSummary({ result }: IngestionSummaryProps) {
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
  /**
   * OpenWiki operation represented by the view.
   */
  command: OpenWikiCommand;

  /**
   * Opt-in credential diagnostics captured for this run.
   *
   * @default undefined - credential diagnostics are hidden.
   */
  credentialDiagnostics?: CredentialDiagnostic[];

  /**
   * Bounded progress and completion model for the run.
   */
  log: RunLogItem[];

  /**
   * Whether to render a finished run instead of live progress.
   *
   * @default false
   */
  done?: boolean;

  /**
   * Elapsed wall-clock time for an agent run.
   *
   * @default undefined - omitted for views that do not own the run timer.
   */
  durationMs?: number;

  /**
   * Echoed user prompt to show above the run.
   *
   * @default null - no prompt is shown.
   */
  message?: string | null;

  /**
   * Explicit model id for the header.
   *
   * @default null - the header resolves the configured default model.
   */
  modelId?: string | null;
}

/**
 * The live agent run view: a compact header, stable run status, and bounded
 * repository/OpenWiki activity trees.
 */
export function RunView({
  command,
  credentialDiagnostics,
  log,
  done = false,
  durationMs,
  message = null,
  modelId = null,
}: RunViewProps) {
  const summary = findRunSummary(log);
  const repositoryProgress = findRepositoryProgress(log);
  const activities = log.filter((item) => item.type === "activity");
  const debugItems = log.filter((item) => item.type === "debug");

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
          {done ? (
            <>
              <Text color="green">✓ </Text>
              <Text bold>
                {formatRunCompletionTitle(command, log, durationMs)}
              </Text>
            </>
          ) : (
            <>
              <RunSpinner />
              <Text bold>Working</Text>{" "}
              <Text color="gray">openwiki {command} · in progress</Text>
            </>
          )}
        </Text>
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          {!done ? (
            <Text>
              <Text bold>
                {repositoryProgress
                  ? formatRepositoryProgress(repositoryProgress, command)
                  : getRunStage(command, activities)}
              </Text>
            </Text>
          ) : null}
          {!done && summary ? (
            <Box marginLeft={2}>
              <Text color={summary.errorCount ? "red" : "gray"}>
                {summary.content}
              </Text>
            </Box>
          ) : null}
          {!done && activities.length > 0 ? (
            <RunActivitySections
              activities={activities}
              exploredPaths={summary?.exploredPaths ?? []}
            />
          ) : null}
          {!done
            ? debugItems.map((item) => (
                <DebugLogLine item={item} key={item.id} />
              ))
            : null}
          {done ? <CompletedRunDetails command={command} log={log} /> : null}
          {!done &&
          !repositoryProgress &&
          !summary &&
          activities.length === 0 ? (
            <Box marginLeft={2}>
              <Text color="gray">Preparing the run...</Text>
            </Box>
          ) : null}
        </Box>
      </Box>
      {credentialDiagnostics ? (
        <CredentialDiagnosticsPanel diagnostics={credentialDiagnostics} />
      ) : null}
    </Box>
  );
}

/**
 * A slow, fixed-width heartbeat that leaves the surrounding layout stable.
 */
function RunSpinner() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((current) => (current + 1) % RUN_SPINNER_FRAMES.length);
    }, RUN_SPINNER_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };
  }, []);

  return <Text color="cyan">{RUN_SPINNER_FRAMES[frame]} </Text>;
}

/**
 * Props for the completed-run detail block.
 */
interface CompletedRunDetailsProps {
  /**
   * OpenWiki operation represented by the completed run.
   */
  command: OpenWikiCommand;

  /**
   * Bounded run log containing summary counts, written paths, and final text.
   */
  log: RunLogItem[];
}

/**
 * Renders written pages, aggregate counts, diagnostics, and the final assistant
 * response for a completed run.
 */
export function CompletedRunDetails({
  command,
  log,
}: CompletedRunDetailsProps) {
  const summary = findRunSummary(log);
  const repositoryProgress = findRepositoryProgress(log);
  const assistantText = log.find((item) => item.type === "text");
  const debugItems = log.filter((item) => item.type === "debug");
  const writtenPaths = summary?.writtenPaths ?? [];
  const visiblePaths = writtenPaths.slice(0, MAX_COMPLETED_PATHS);
  const hiddenPathCount = writtenPaths.length - visiblePaths.length;
  const summaryText = formatCompletedRunCounts(summary);

  return (
    <Box flexDirection="column">
      {repositoryProgress?.stage === "noop" ? (
        <Text color="gray">
          {formatRepositoryProgress(repositoryProgress, command)}
        </Text>
      ) : null}
      {visiblePaths.map((path) => (
        <Text color="gray" key={path}>
          {path}
        </Text>
      ))}
      {hiddenPathCount > 0 ? (
        <Text color="gray">
          {formatCount(hiddenPathCount, "additional page", "additional pages")}
        </Text>
      ) : null}
      {debugItems.map((item) => (
        <DebugLogLine item={item} key={item.id} />
      ))}
      {summaryText ? (
        <Box marginTop={writtenPaths.length > 0 ? 1 : 0}>
          <Text color={summary?.errorCount ? "red" : "gray"}>
            {summaryText}
          </Text>
        </Box>
      ) : null}
      {assistantText ? (
        <Box
          flexDirection="column"
          marginTop={summaryText || writtenPaths.length > 0 ? 1 : 0}
        >
          <MarkdownText markdown={assistantText.content.trim()} />
        </Box>
      ) : null}
    </Box>
  );
}

function DebugLogLine({ item }: { item: RunDebugLogItem }) {
  return (
    <Text>
      <Text color="gray">- </Text>
      <Text color="gray">{item.content}</Text>
    </Text>
  );
}

/**
 * Renders active repository/OpenWiki paths followed by bounded recent paths.
 */
function RunActivitySections({
  activities,
  exploredPaths,
}: {
  activities: RunActivityLogItem[];
  exploredPaths: string[];
}) {
  const recentItems = activities.filter(
    (item) => item.activityStatus !== "active",
  );
  const sections = [
    {
      title: "Reading OpenWiki",
      items: activities.filter(
        (item) =>
          item.activityStatus === "active" &&
          item.activityScope === "openwiki" &&
          item.activityOperation !== "write",
      ),
    },
    {
      title: "Writing OpenWiki",
      items: activities.filter(
        (item) =>
          item.activityStatus === "active" &&
          item.activityScope === "openwiki" &&
          item.activityOperation === "write",
      ),
    },
    {
      title: "Writing repository",
      items: activities.filter(
        (item) =>
          item.activityStatus === "active" &&
          item.activityScope === "repository" &&
          item.activityOperation === "write",
      ),
    },
  ].filter((section) => section.items.length > 0);
  const activeRepositoryRead = activities
    .slice()
    .reverse()
    .find(
      (item) =>
        item.activityStatus === "active" &&
        item.activityScope === "repository" &&
        item.activityOperation === "read",
    );
  const showExplorationMap =
    exploredPaths.length > 0 || activeRepositoryRead !== undefined;

  return (
    <Box flexDirection="column" marginTop={1}>
      {sections.map((section) => (
        <RunActivitySection
          items={section.items}
          key={section.title}
          title={section.title}
        />
      ))}
      {recentItems.length > 0 ? <RecentActivity items={recentItems} /> : null}
      {showExplorationMap ? (
        <ExplorationMap
          activePath={activeRepositoryRead?.activityPath}
          exploredPaths={exploredPaths}
        />
      ) : null}
    </Box>
  );
}

function ExplorationMap({
  activePath,
  exploredPaths,
}: {
  activePath?: string;
  exploredPaths: string[];
}) {
  const lines = buildExplorationTreeLines(exploredPaths, activePath);
  const terminalRows = useTerminalRows();
  const viewportHeight = Math.min(
    MAX_EXPLORATION_VIEWPORT_LINES,
    Math.max(
      MIN_EXPLORATION_VIEWPORT_LINES,
      terminalRows - EXPLORATION_VIEWPORT_RESERVED_ROWS,
    ),
  );
  const maxScrollOffset = Math.max(0, lines.length - viewportHeight);
  const activeLineIndex = lines.findIndex((line) => line.active);
  const followOffset =
    activeLineIndex === -1
      ? maxScrollOffset
      : Math.min(
          maxScrollOffset,
          Math.max(0, activeLineIndex - viewportHeight + 1),
        );
  const [manualScrollOffset, setManualScrollOffset] = useState<number | null>(
    null,
  );
  const scrollOffset =
    manualScrollOffset === null
      ? followOffset
      : Math.min(manualScrollOffset, maxScrollOffset);
  const visibleLines = lines.slice(scrollOffset, scrollOffset + viewportHeight);
  const isScrollable = lines.length > viewportHeight;

  useInput(
    (input, key) => {
      if (input === "f" && !key.ctrl && !key.meta) {
        setManualScrollOffset(null);
        return;
      }

      const lineDelta =
        key.upArrow || input === "k"
          ? -1
          : key.downArrow || input === "j"
            ? 1
            : key.pageUp
              ? -viewportHeight
              : key.pageDown
                ? viewportHeight
                : 0;

      if (lineDelta === 0) {
        return;
      }

      setManualScrollOffset((currentOffset) => {
        const effectiveOffset = currentOffset ?? followOffset;

        return Math.min(
          maxScrollOffset,
          Math.max(0, effectiveOffset + lineDelta),
        );
      });
    },
    { isActive: isScrollable },
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold>Exploration map</Text>
        <Text color="gray">
          {` · ${formatCount(exploredPaths.length, "file", "files")}`}
        </Text>
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        {visibleLines.map((line, index) => (
          <Text
            color={line.active ? "cyan" : "gray"}
            key={`${line.label}:${scrollOffset + index}`}
            wrap="truncate-end"
          >
            {line.label}
          </Text>
        ))}
      </Box>
      {isScrollable ? (
        <Box marginLeft={2}>
          <Text color="gray" wrap="truncate-end">
            {`${scrollOffset + 1}–${scrollOffset + visibleLines.length} of ${lines.length} · ↑/↓ or j/k scroll · PgUp/PgDn · f follow · ${manualScrollOffset === null ? "following active file" : "scroll paused"}`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function useTerminalRows(): number {
  const { stdout } = useStdout();
  const [terminalRows, setTerminalRows] = useState(
    stdout.rows ?? DEFAULT_TERMINAL_ROWS,
  );

  useEffect(() => {
    const updateTerminalRows = () => {
      setTerminalRows(stdout.rows ?? DEFAULT_TERMINAL_ROWS);
    };

    stdout.on("resize", updateTerminalRows);

    return () => {
      stdout.off("resize", updateTerminalRows);
    };
  }, [stdout]);

  return terminalRows;
}

function RunActivitySection({
  items,
  title,
}: {
  items: RunActivityLogItem[];
  title: string;
}) {
  const visibleItems = items.slice(-4);
  const lines = buildActivityTreeLines(
    visibleItems.map((item) => ({
      path: item.activityPath,
      status: item.activityStatus,
    })),
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{title}</Text>
      <Box flexDirection="column" marginLeft={2}>
        {lines.map((line, index) => (
          <Text
            color={
              line.status === "error"
                ? "red"
                : line.status === "active"
                  ? "cyan"
                  : "gray"
            }
            key={`${line.label}:${index}`}
            wrap="truncate-end"
          >
            {line.label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function RecentActivity({ items }: { items: RunActivityLogItem[] }) {
  const visibleItems = items.slice(-4).reverse();

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>Recent activity</Text>
      <Box flexDirection="column" marginLeft={2}>
        {visibleItems.map((item) => (
          <Text key={item.id} wrap="truncate-end">
            <Text color={item.activityStatus === "error" ? "red" : "gray"}>
              {`${getActivityVerb(item).padEnd(8)} `}
            </Text>
            <Text color="gray">{item.activityPath}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function getActivityVerb(item: RunActivityLogItem): string {
  if (item.activityStatus === "error") {
    return "failed";
  }

  return {
    read: "read",
    search: "searched",
    write: "wrote",
  }[item.activityOperation];
}

function getRunStage(
  command: OpenWikiCommand,
  activities: RunActivityLogItem[],
): string {
  if (
    activities.some(
      (item) =>
        item.activityStatus === "active" && item.activityOperation === "write",
    )
  ) {
    return "Writing documentation";
  }

  if (activities.some((item) => item.activityStatus === "active")) {
    return command === "update"
      ? "Tracing affected documentation"
      : "Exploring the repository";
  }

  return command === "update"
    ? "Tracing affected documentation"
    : "Building the documentation map";
}
