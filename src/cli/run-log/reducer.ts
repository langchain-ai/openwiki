import type React from "react";
import type { OpenWikiRunEvent } from "../../agent/types.js";
import { getToolPathActivities, isOpenWikiPagePath } from "./activity.js";
import { findRunSummary, formatRunCounts } from "./summary.js";
import { countToolTargets } from "./tool-input.js";
import type { RunLogItem, RunToolLogItem } from "./types.js";

const MAX_DEBUG_ITEMS = 20;
const MAX_RECENT_ACTIVITIES = 8;

/**
 * Folds a run event into a bounded progress model. Main-agent prose is kept as
 * one replaceable buffer, subgraph prose is discarded, and filesystem tools
 * contribute exact path activity without exposing their transcript.
 */
export function appendRunLogEvent(
  log: RunLogItem[],
  event: OpenWikiRunEvent,
  nextLogId: React.MutableRefObject<number>,
): RunLogItem[] {
  if (event.type === "repository_progress") {
    const existing = log.find((item) => item.type === "repository_progress");
    const progress: RunLogItem = {
      id: existing?.id ?? nextLogId.current++,
      type: "repository_progress",
      stage: event.stage,
      ...(event.resumed === undefined ? {} : { resumed: event.resumed }),
      ...(event.page === undefined ? {} : { page: event.page }),
      ...(event.pageIndex === undefined ? {} : { pageIndex: event.pageIndex }),
      ...(event.pageCount === undefined ? {} : { pageCount: event.pageCount }),
    };

    return existing
      ? log.map((item) =>
          item.type === "repository_progress" ? progress : item,
        )
      : [progress, ...log];
  }

  if (event.type === "text") {
    if (event.source === "subgraph" || event.text.length === 0) {
      return log;
    }

    return appendAssistantText(log, event.text, nextLogId);
  }

  if (event.type === "tool_start") {
    return appendToolStartLogItem(log, event, nextLogId);
  }

  if (event.type === "tool_end") {
    return completeToolLogItem(log, event);
  }

  const debugItems = log.filter((item) => item.type === "debug");
  const withoutOldestDebug =
    debugItems.length >= MAX_DEBUG_ITEMS
      ? removeItemById(log, debugItems[0]?.id)
      : log;

  return [
    ...withoutOldestDebug,
    {
      id: nextLogId.current++,
      type: "debug",
      content: event.message,
    },
  ];
}

function appendAssistantText(
  log: RunLogItem[],
  text: string,
  nextLogId: React.MutableRefObject<number>,
): RunLogItem[] {
  const existingText = log.find((item) => item.type === "text");

  if (!existingText) {
    return [...log, { id: nextLogId.current++, type: "text", content: text }];
  }

  return log.map((item) =>
    item.type === "text"
      ? { ...item, content: `${item.content}${text}` }
      : item,
  );
}

/**
 * Records a tool action in the single run summary and activates any explicit
 * filesystem paths carried by the call. Earlier prose is discarded because a
 * later tool call proves that prose was narration rather than the final answer.
 */
function appendToolStartLogItem(
  log: RunLogItem[],
  event: Extract<OpenWikiRunEvent, { type: "tool_start" }>,
  nextLogId: React.MutableRefObject<number>,
): RunLogItem[] {
  const withoutNarration = log.filter((item) => item.type !== "text");
  const previousSummary = findRunSummary(withoutNarration);
  const summaryIndex = previousSummary
    ? withoutNarration.indexOf(previousSummary)
    : -1;
  const actionCount = (previousSummary?.actionCount ?? 0) + 1;
  const readCount =
    (previousSummary?.readCount ?? 0) + (event.name === "read_file" ? 1 : 0);
  const searchCount =
    (previousSummary?.searchCount ?? 0) +
    (["glob", "grep", "ls"].includes(event.name) ? 1 : 0);
  const taskCount =
    (previousSummary?.taskCount ?? 0) +
    (event.name === "task"
      ? countToolTargets(event.input, ["tasks", "subagents", "agents", "items"])
      : 0);
  const writeCount =
    (previousSummary?.writeCount ?? 0) +
    (["edit_file", "write_file"].includes(event.name) ? 1 : 0);
  const activeToolCallIds = [
    ...getActiveToolCallIds(previousSummary),
    event.id,
  ];
  const summary: RunLogItem = {
    ...previousSummary,
    actionCount,
    activeToolCallIds,
    content: formatRunCounts({
      actionCount,
      readCount,
      searchCount,
      taskCount,
      writeCount,
    }),
    errorCount: previousSummary?.errorCount ?? 0,
    id: previousSummary?.id ?? nextLogId.current++,
    readCount,
    searchCount,
    status: "running",
    taskCount,
    type: "tool",
    writeCount,
  };
  let nextLog: RunLogItem[] =
    summaryIndex === -1
      ? [summary, ...withoutNarration]
      : withoutNarration.map((item, index) =>
          index === summaryIndex ? summary : item,
        );

  for (const activity of getToolPathActivities(event)) {
    nextLog = activatePath(nextLog, activity, event.id, nextLogId);
  }

  return boundActivityLog(nextLog);
}

/**
 * Completes a tool in both the aggregate progress summary and every path it
 * activated. Unknown completions are ignored because providers may omit a
 * matching start event.
 */
function completeToolLogItem(
  log: RunLogItem[],
  event: Extract<OpenWikiRunEvent, { type: "tool_end" }>,
): RunLogItem[] {
  const matchingIndex = findLastToolLogItemIndex(log, event.id);

  if (matchingIndex === -1) {
    return log;
  }

  const writtenPaths =
    event.status === "finished"
      ? log.flatMap((item) =>
          item.type === "activity" &&
          item.activityOperation === "write" &&
          isOpenWikiPagePath(item.activityPath) &&
          getActiveToolCallIds(item).includes(event.id)
            ? [item.activityPath]
            : [],
        )
      : [];
  const exploredPaths =
    event.status === "finished"
      ? log.flatMap((item) =>
          item.type === "activity" &&
          item.activityOperation === "read" &&
          item.activityScope === "repository" &&
          getActiveToolCallIds(item).includes(event.id)
            ? [item.activityPath]
            : [],
        )
      : [];

  const touchedActivityIds = new Set(
    log
      .filter(
        (item) =>
          item.type === "activity" &&
          getActiveToolCallIds(item).includes(event.id),
      )
      .map((item) => item.id),
  );
  const completed = log.map((item, index): RunLogItem => {
    if (index === matchingIndex && item.type === "tool") {
      return completeToolGroupItem(item, event, writtenPaths, exploredPaths);
    }

    if (
      item.type !== "activity" ||
      !getActiveToolCallIds(item).includes(event.id)
    ) {
      return item;
    }

    const activeToolCallIds = getActiveToolCallIds(item).filter(
      (id) => id !== event.id,
    );

    return {
      ...item,
      activeToolCallIds,
      activityStatus:
        activeToolCallIds.length > 0
          ? "active"
          : event.status === "error"
            ? "error"
            : "recent",
    };
  });

  const reordered = [
    ...completed.filter((item) => !touchedActivityIds.has(item.id)),
    ...completed.filter((item) => touchedActivityIds.has(item.id)),
  ];

  return boundActivityLog(reordered);
}

/**
 * Applies one completion to the aggregate run summary.
 */
function completeToolGroupItem(
  item: RunToolLogItem,
  event: Extract<OpenWikiRunEvent, { type: "tool_end" }>,
  writtenPaths: string[] = [],
  exploredPaths: string[] = [],
): RunLogItem {
  const actionCount = item.actionCount ?? 1;
  const readCount = item.readCount ?? 0;
  const searchCount = item.searchCount ?? 0;
  const taskCount = item.taskCount ?? 0;
  const writeCount = item.writeCount ?? 0;
  const activeToolCallIds = getActiveToolCallIds(item).filter(
    (id) => id !== event.id,
  );
  const errorCount =
    (item.errorCount ?? 0) + (event.status === "error" ? 1 : 0);
  const counts = formatRunCounts({
    actionCount,
    errorCount,
    readCount,
    searchCount,
    taskCount,
    writeCount,
  });

  return {
    ...item,
    activeToolCallIds,
    content: counts,
    errorCount,
    exploredPaths: [
      ...new Set([...(item.exploredPaths ?? []), ...exploredPaths]),
    ],
    writtenPaths: [...new Set([...(item.writtenPaths ?? []), ...writtenPaths])],
    status:
      activeToolCallIds.length > 0
        ? "running"
        : errorCount > 0
          ? "error"
          : "done",
  };
}

/**
 * Finds the run summary that owns a still-active tool id, or -1 when the start
 * event was not observed.
 */
function findLastToolLogItemIndex(
  log: RunLogItem[],
  toolCallId: string,
): number {
  return log.findIndex(
    (item) =>
      item.type === "tool" && getActiveToolCallIds(item).includes(toolCallId),
  );
}

/**
 * Returns all active call ids recorded on a log item.
 */
function getActiveToolCallIds(item?: RunLogItem): string[] {
  return item?.type === "activity" || item?.type === "tool"
    ? (item.activeToolCallIds ?? [])
    : [];
}

function activatePath(
  log: RunLogItem[],
  activity: ReturnType<typeof getToolPathActivities>[number],
  toolCallId: string,
  nextLogId: React.MutableRefObject<number>,
): RunLogItem[] {
  const matching = log.find(
    (item) =>
      item.type === "activity" &&
      item.activityOperation === activity.operation &&
      item.activityPath === activity.path,
  );
  const withoutMatching = matching
    ? log.filter((item) => item.id !== matching.id)
    : log;
  const activeToolCallIds = [
    ...new Set([...getActiveToolCallIds(matching), toolCallId]),
  ];

  return [
    ...withoutMatching,
    {
      ...matching,
      activeToolCallIds,
      activityOperation: activity.operation,
      activityPath: activity.path,
      activityScope: activity.scope,
      activityStatus: "active",
      id: matching?.id ?? nextLogId.current++,
      type: "activity",
    },
  ];
}

function boundActivityLog(log: RunLogItem[]): RunLogItem[] {
  const nonActivities = log.filter((item) => item.type !== "activity");
  const activeActivities = log.filter(
    (item) => item.type === "activity" && item.activityStatus === "active",
  );
  const recentActivities = log
    .filter(
      (item) => item.type === "activity" && item.activityStatus !== "active",
    )
    .slice(-MAX_RECENT_ACTIVITIES);

  return [...nonActivities, ...activeActivities, ...recentActivities];
}

function removeItemById(
  log: RunLogItem[],
  id: number | undefined,
): RunLogItem[] {
  return id === undefined ? log : log.filter((item) => item.id !== id);
}
