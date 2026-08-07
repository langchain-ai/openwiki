/**
 * A single line in a run's activity log: streamed assistant text, a debug
 * notice, or a tool action (which may be collapsed into a group of several
 * actions sharing one line).
 */
export interface RunLogItem {
  /**
   * The rendered text for the line in its current state.
   */
  content: string;

  /**
   * The line's identity, stable across in-place updates as a tool progresses.
   */
  id: number;

  /**
   * Which kind of line this is, selecting how it renders.
   */
  type: "debug" | "text" | "tool";

  /**
   * How many tool actions are collapsed into this line.
   *
   * @default undefined - treated as a single action.
   */
  actionCount?: number;

  /**
   * The ids of the tool calls in this group that are still running.
   *
   * @default undefined - fall back to `toolCallId` when the line is running.
   */
  activeToolCallIds?: string[];

  /**
   * The tool's raw call string, shown only when the display opts into detail.
   *
   * @default undefined - no call detail is shown.
   */
  call?: string;

  /**
   * The text to render once the line has finished.
   *
   * @default undefined - the line has no distinct completed form yet.
   */
  doneContent?: string;

  /**
   * How many actions in this group failed.
   *
   * @default undefined - treated as zero failures.
   */
  errorCount?: number;

  /**
   * The completed text of the most recently finished action in the group.
   *
   * @default undefined - falls back to `doneContent`.
   */
  latestDoneContent?: string;

  /**
   * The line's lifecycle state (tool lines only).
   *
   * @default undefined - the line is not a tracked tool action.
   */
  status?: "done" | "error" | "running";

  /**
   * The id of the tool call this line most recently represents.
   *
   * @default undefined - the line is not a tool action.
   */
  toolCallId?: string;

  /**
   * The name of the tool this line most recently represents.
   *
   * @default undefined - the line is not a tool action.
   */
  toolName?: string;
}
