import type React from "react";
import type { OpenWikiRunEvent } from "../../agent/types.js";
import { createToolDisplay, formatCount } from "./tool-display.js";
import type { RunLogItem } from "./types.js";

/**
 * Folds a single run event into the activity log, returning the next log.
 * Empty and subgraph text events are dropped, tool events update the tool
 * group in place, and consecutive assistant text is concatenated onto the last
 * line; other events append a new line and advance `nextLogId`.
 */
export function appendRunLogEvent(
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

/**
 * Appends a starting tool call to the log, merging it into the previous line
 * when that line is already a tool group (bumping its action count) or starting
 * a fresh tool line otherwise.
 */
export function appendToolStartLogItem(
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

/**
 * Marks the tool call identified by `event.id` complete within its group,
 * leaving the log unchanged when no matching running line is found.
 */
export function completeToolLogItem(
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

/**
 * Applies a tool completion to its group line: drops the finished call id,
 * tallies failures, and stays `running` while sibling calls remain, otherwise
 * settles to `done` or `error`.
 */
export function completeToolGroupItem(
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

/**
 * Finds the index of the most recent still-running tool line that owns
 * `toolCallId`, or -1 when none does.
 */
export function findLastToolLogItemIndex(
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

/**
 * Returns the id of the most recent still-running tool line, or null when no
 * tool is currently running.
 */
export function getActiveRunningToolLogId(log: RunLogItem[]): number | null {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const item = log[index];

    if (item.type === "tool" && item.status === "running") {
      return item.id;
    }
  }

  return null;
}

/**
 * Returns the running tool call ids for a line, falling back to the single
 * `toolCallId` for legacy running lines and an empty list otherwise.
 */
export function getActiveToolCallIds(item: RunLogItem): string[] {
  if (item.activeToolCallIds) {
    return item.activeToolCallIds;
  }

  if (item.status === "running" && item.toolCallId) {
    return [item.toolCallId];
  }

  return [];
}

/**
 * Formats the in-progress label for a tool group, naming the current action
 * and, for groups, the number of actions underway.
 */
export function formatToolGroupRunning(
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

/**
 * Formats the completed label for a tool group, surfacing the failure count
 * when any action failed and the latest completed action for singletons.
 */
export function formatToolGroupDone(
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
