import { OPENWIKI_CLICKUP_API_TOKEN_ENV_KEY } from "../../constants.js";
import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../io.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

/**
 * Configuration for the ClickUp connector.
 * Read from `~/.openwiki/connectors/clickup/config.json`.
 */
interface ClickUpConfig {
  /** Whether the connector is enabled. @default false */
  enabled?: boolean;
  /** Specific folder IDs to ingest from. If empty, all folders are included. @default [] */
  folderIds?: string[];
  /** Whether to include subtasks in the ingestion. @default true */
  includeSubtasks?: boolean;
  /** Specific list IDs to ingest from. If empty, all lists are included. @default [] */
  listIds?: string[];
  /** Maximum number of tasks to fetch per list (1–1000). @default 100 */
  maxTasksPerList?: number;
  /** Specific space IDs to ingest from. If empty, all spaces are included. @default [] */
  spaceIds?: string[];
  /** Additional task fields to include. @default [] */
  taskFields?: string[];
  /** Time window in hours for incremental sync. @default 168 */
  windowHours?: number;
  /** Specific workspace IDs to ingest from. If empty, all workspaces are included. @default [] */
  workspaceIds?: string[];
}

/** A ClickUp workspace (team). */
interface ClickUpWorkspace {
  /** Workspace ID. */
  id?: string;
  /** Workspace name. */
  name?: string;
}

/** A ClickUp space within a workspace. */
interface ClickUpSpace {
  /** Space ID. */
  id?: string;
  /** Space name. */
  name?: string;
  /** Whether the space is private. */
  private?: boolean;
}

/** A ClickUp list within a space. */
interface ClickUpList {
  /** List ID. */
  id?: string;
  /** List name. */
  name?: string;
  /** Sort order index. */
  orderindex?: number;
  /** The parent space this list belongs to. */
  space?: { id?: string };
}

/** A ClickUp task. */
interface ClickUpTask {
  /** Assignees on this task. */
  assignees?: ClickUpAssignee[];
  /** Custom field values. */
  custom_fields?: ClickUpCustomField[];
  /** Timestamp when the task was closed, or null. */
  date_closed?: number | null;
  /** Timestamp when the task was created. */
  date_created?: number;
  /** Timestamp when the task was marked done, or null. */
  date_done?: number | null;
  /** Timestamp when the task was last updated. */
  date_updated?: number;
  /** Plain-text task description. */
  description?: string;
  /** Due date timestamp, or null. */
  due_date?: number | null;
  /** Task ID. */
  id?: string;
  /** Link to another task, or null. */
  links_to?: string | null;
  /** Markdown-formatted task description. */
  markdown_description?: string;
  /** Task name. */
  name?: string;
  /** Sort order index. */
  orderindex?: number;
  /** Task priority. */
  priority?: ClickUpPriority;
  /** Task status. */
  status?: ClickUpStatus;
  /** Nested subtasks. */
  subtasks?: ClickUpTask[];
  /** Tags applied to the task. */
  tags?: ClickUpTag[];
  /** Plain-text content of the task. */
  text_content?: string;
  /** ClickUp URL for the task. */
  url?: string;
}

/** A user assigned to a ClickUp task. */
interface ClickUpAssignee {
  /** User's display color. */
  color?: string;
  /** User's email address. */
  email?: string;
  /** Numeric user ID. */
  id?: number;
  /** URL of the user's profile photo. */
  profilePhoto?: string;
  /** Username. */
  username?: string;
}

/** A custom field attached to a ClickUp task. */
interface ClickUpCustomField {
  /** Custom field ID. */
  id?: string;
  /** Custom field name. */
  name?: string;
  /** Type-specific configuration, including dropdown options. */
  type_config?: {
    /** Available options for dropdown-type fields. */
    options?: { id?: string; label?: string; orderindex?: number }[];
  };
  /** The field's value. */
  value?: unknown;
}

/** Priority level of a ClickUp task. */
interface ClickUpPriority {
  /** Display color for the priority. */
  color?: string;
  /** Priority ID. */
  id?: string;
  /** Sort order index. */
  orderindex?: number;
  /** Priority label (e.g. "urgent", "high"). */
  priority?: string;
}

/** Status of a ClickUp task. */
interface ClickUpStatus {
  /** Status display color. */
  color?: string;
  /** Status ID. */
  id?: string;
  /** Status label (e.g. "to do", "in progress"). */
  status?: string;
  /** Status type category. */
  type?: string;
}

/** A tag applied to a ClickUp task. */
interface ClickUpTag {
  /** Tag display color. */
  color?: string;
  /** User ID of the tag creator. */
  creator?: number;
  /** Tag ID. */
  id?: string;
  /** Tag name. */
  name?: string;
  /** Sort order index. */
  orderindex?: number;
}

/** A comment on a ClickUp task. */
interface ClickUpComment {
  /** Plain-text comment body. */
  comment_text?: string;
  /** Timestamp of the comment as an ISO string. */
  date?: string;
  /** Comment ID. */
  id?: string;
  /** Rich-text comment body. */
  text_content?: string;
  /** The user who posted the comment. */
  user?: ClickUpCommentUser;
}

/** The user who authored a ClickUp comment. */
interface ClickUpCommentUser {
  /** Commenter's email address. */
  email?: string;
  /** Numeric user ID. */
  id?: number;
  /** Commenter's username. */
  username?: string;
}

/** Response shape for the ClickUp task list endpoint. */
interface ClickUpTaskPage {
  /** Array of tasks on this page. */
  tasks?: ClickUpTask[];
}

/** Response shape for the ClickUp workspace (team) endpoint. */
interface ClickUpWorkspaceResponse {
  /** Array of workspaces. */
  teams?: ClickUpWorkspace[];
}

/** Response shape for the ClickUp space listing endpoint. */
interface ClickUpSpaceResponse {
  /** Array of spaces. */
  spaces?: ClickUpSpace[];
}

/** Response shape for the ClickUp list listing endpoint. */
interface ClickUpListResponse {
  /** Array of lists. */
  lists?: ClickUpList[];
}

/** Response shape for the ClickUp task comment endpoint. */
interface ClickUpCommentResponse {
  /** Array of comments. */
  comments?: ClickUpComment[];
}

/** A task enriched with its comments and resolved subtasks. */
interface ClickUpEnrichedTask extends ClickUpTask {
  /** Comments on this task. */
  comments: ClickUpComment[];
  /** Number of direct subtasks. */
  subtaskCount: number;
  /** Resolved subtask data. */
  subtasks: ClickUpEnrichedTask[];
}

/** ClickUp API v2 base URL. */
const CLICKUP_API_BASE_URL = "https://api.clickup.com/api/v2";

/** Default maximum number of tasks to fetch per list. */
const DEFAULT_MAX_TASKS_PER_LIST = 100;

/** Default time window in hours for incremental sync (7 days). */
const DEFAULT_WINDOW_HOURS = 168;

/** Maximum number of retry attempts for rate-limited (429) requests. */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff. */
const BASE_RETRY_DELAY_MS = 1000;

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches ClickUp workspaces, tasks, subtasks, and comments through the ClickUp API v2 with a personal API token.",
  displayName: "ClickUp",
  id: "clickup",
  requiredEnv: [OPENWIKI_CLICKUP_API_TOKEN_ENV_KEY],
  supportsAgenticDiscovery: false,
};

/**
 * Creates the ClickUp connector runtime.
 * @returns A {@link ConnectorRuntime} that can ingest ClickUp data.
 */
export function createClickUpConnector(): ConnectorRuntime {
  return {
    ...definition,
    ingest,
  };
}

/**
 * Main ingestion entry point. Fetches workspaces, spaces, lists, tasks, and
 * comments from ClickUp and writes them as raw JSON files.
 *
 * @param options - Ingestion options (e.g. window override).
 * @returns Ingestion result with status, warnings, and output file paths.
 */
async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = await readConnectorConfig<ClickUpConfig>("clickup", {
    enabled: false,
    folderIds: [],
    includeSubtasks: true,
    listIds: [],
    maxTasksPerList: DEFAULT_MAX_TASKS_PER_LIST,
    spaceIds: [],
    taskFields: [],
    windowHours: DEFAULT_WINDOW_HOURS,
    workspaceIds: [],
  });
  const state = await readConnectorState("clickup");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "clickup",
      message:
        "ClickUp connector is not enabled. Set enabled=true in ~/.openwiki/connectors/clickup/config.json.",
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/clickup/state.json",
      status: "skipped",
      warnings,
    };
  }

  if (!process.env[OPENWIKI_CLICKUP_API_TOKEN_ENV_KEY]) {
    return {
      connectorId: "clickup",
      message: `${OPENWIKI_CLICKUP_API_TOKEN_ENV_KEY} is required for ClickUp ingestion.`,
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/clickup/state.json",
      status: "error",
      warnings,
    };
  }

  const token = process.env[OPENWIKI_CLICKUP_API_TOKEN_ENV_KEY];
  const maxTasksPerList = clamp(
    config.maxTasksPerList,
    1,
    1000,
    DEFAULT_MAX_TASKS_PER_LIST,
  );
  const windowStart = getWindowStartTime(
    options.windowHours ?? config.windowHours,
  );
  const latestIds = { ...(state.latestIds ?? {}) };

  const workspaces = await fetchWorkspaces(token);
  rawFiles.push(
    await writeRawJson("clickup", runId, "workspaces.json", {
      fetchedAt: new Date().toISOString(),
      workspaces,
    }),
  );

  for (const workspace of workspaces) {
    if (!workspace.id) {
      continue;
    }

    if (
      (config.workspaceIds?.length ?? 0) > 0 &&
      !config.workspaceIds?.includes(workspace.id)
    ) {
      continue;
    }

    const lists = await fetchListsForWorkspace(token, workspace.id, config);

    for (const list of lists) {
      if (!list.id) {
        continue;
      }

      const listKey = `list:${list.id}`;
      const tasks = await fetchTasksForList(token, list.id, {
        maxTasksPerList,
        sinceDate: latestIds[listKey]
          ? Number(latestIds[listKey])
          : windowStart,
      });

      if (tasks.length === 0) {
        continue;
      }

      const tasksWithComments = await enrichTasksWithComments(
        token,
        tasks,
        config.includeSubtasks !== false,
      );

      rawFiles.push(
        await writeRawJson(
          "clickup",
          runId,
          `list-${list.id}-tasks.json`,
          {
            fetchedAt: new Date().toISOString(),
            list: { id: list.id, name: list.name, spaceId: list.space?.id },
            taskCount: tasksWithComments.length,
            tasks: tasksWithComments,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
          },
        ),
      );

      const newestTimestamp = getNewestTaskTimestamp(tasks);
      if (newestTimestamp !== null) {
        latestIds[listKey] = String(newestTimestamp);
      }
    }
  }

  await writeConnectorState(
    "clickup",
    updateStateWithRun(
      {
        ...state,
        latestIds: removeEmptyValues(latestIds),
      },
      {
        at: new Date().toISOString(),
        rawFiles,
        runId,
        status: rawFiles.length > 0 ? "success" : "skipped",
        warnings,
      },
    ),
  );

  return {
    connectorId: "clickup",
    message: `Fetched ClickUp data across ${workspaces.length} workspace(s), ${rawFiles.length - 1} list dump(s).`,
    rawFiles,
    runId,
    statePath: "~/.openwiki/connectors/clickup/state.json",
    status: rawFiles.length > 0 ? "success" : "skipped",
    warnings,
  };
}

/**
 * Fetches all workspaces (teams) accessible with the given token.
 *
 * @param token - ClickUp personal API token.
 * @returns Array of workspaces, or an empty array on failure.
 */
async function fetchWorkspaces(
  token: string,
): Promise<ClickUpWorkspace[]> {
  try {
    const response = await clickUpApi<ClickUpWorkspaceResponse>(token, "/team");
    return response.teams ?? [];
  } catch (error) {
    console.warn(
      `[clickup] Failed to fetch workspaces: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Fetches all lists for a workspace, either by resolving explicit `listIds`
 * from config or by traversing spaces.
 *
 * @param token - ClickUp personal API token.
 * @param workspaceId - The workspace (team) ID.
 * @param config - Connector configuration.
 * @returns Array of lists found in the workspace.
 */
async function fetchListsForWorkspace(
  token: string,
  workspaceId: string,
  config: ClickUpConfig,
): Promise<ClickUpList[]> {
  const lists: ClickUpList[] = [];

  if ((config.listIds?.length ?? 0) > 0) {
    for (const listId of config.listIds ?? []) {
      try {
        const list = await clickUpApi<ClickUpList>(
          token,
          `/list/${encodeURIComponent(listId)}`,
        );
        lists.push(list);
      } catch {
        // List may not be accessible; skip silently
      }
    }
    return lists;
  }

  const spaces = await fetchSpacesForWorkspace(token, workspaceId, config);

  for (const space of spaces) {
    if (!space.id) {
      continue;
    }

    const spaceLists = await fetchListsForSpace(token, space.id);
    lists.push(...spaceLists);
  }

  return lists;
}

/**
 * Fetches spaces for a workspace, either by resolving explicit `spaceIds`
 * from config or by listing all spaces in the workspace.
 *
 * @param token - ClickUp personal API token.
 * @param workspaceId - The workspace (team) ID.
 * @param config - Connector configuration.
 * @returns Array of spaces found in the workspace.
 */
async function fetchSpacesForWorkspace(
  token: string,
  workspaceId: string,
  config: ClickUpConfig,
): Promise<ClickUpSpace[]> {
  if ((config.spaceIds?.length ?? 0) > 0) {
    const spaces: ClickUpSpace[] = [];
    for (const spaceId of config.spaceIds ?? []) {
      try {
        const space = await clickUpApi<ClickUpSpace>(
          token,
          `/space/${encodeURIComponent(spaceId)}`,
        );
        spaces.push(space);
      } catch {
        // Space may not be accessible; skip silently
      }
    }
    return spaces;
  }

  try {
    const response = await clickUpApi<ClickUpSpaceResponse>(
      token,
      `/team/${encodeURIComponent(workspaceId)}/space`,
    );
    return response.spaces ?? [];
  } catch (error) {
    console.warn(
      `[clickup] Failed to fetch spaces for workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Fetches all lists within a space.
 *
 * @param token - ClickUp personal API token.
 * @param spaceId - The space ID.
 * @returns Array of lists in the space.
 */
async function fetchListsForSpace(
  token: string,
  spaceId: string,
): Promise<ClickUpList[]> {
  try {
    const response = await clickUpApi<ClickUpListResponse>(
      token,
      `/space/${encodeURIComponent(spaceId)}/list`,
    );
    return response.lists ?? [];
  } catch (error) {
    console.warn(
      `[clickup] Failed to fetch lists for space ${spaceId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Fetches tasks for a list with pagination support. Pages through the ClickUp
 * API until `maxTasksPerList` tasks have been collected or no more pages remain.
 *
 * @param token - ClickUp personal API token.
 * @param listId - The list ID to fetch tasks from.
 * @param options - Fetch options.
 * @param options.maxTasksPerList - Maximum tasks to return.
 * @param options.sinceDate - If set, only tasks updated/created after this
 *   timestamp are included.
 * @returns Array of tasks matching the criteria.
 */
async function fetchTasksForList(
  token: string,
  listId: string,
  options: {
    maxTasksPerList: number;
    sinceDate: number | undefined;
  },
): Promise<ClickUpTask[]> {
  const allTasks: ClickUpTask[] = [];
  let page = 0;

  while (allTasks.length < options.maxTasksPerList) {
    const params: Record<string, string> = {
      page: String(page),
      subtasks: "true",
      include_closed: "true",
    };

    if (options.sinceDate !== undefined) {
      params.order_by = "updated";
    }

    const response = await clickUpApi<ClickUpTaskPage>(
      token,
      `/list/${encodeURIComponent(listId)}/task`,
      params,
    );

    const tasks = response.tasks ?? [];
    if (tasks.length === 0) {
      break;
    }

    for (const task of tasks) {
      if (allTasks.length >= options.maxTasksPerList) {
        break;
      }

      if (options.sinceDate !== undefined) {
        const updated = task.date_updated ?? 0;
        const created = task.date_created ?? 0;
        if (updated <= options.sinceDate && created <= options.sinceDate) {
          continue;
        }
      }

      allTasks.push(task);
    }

    // If the API returned fewer tasks than a full page, we've reached the end
    if (tasks.length < 100) {
      break;
    }

    page++;
  }

  return allTasks;
}

/**
 * Enriches tasks with their comments and optionally resolves subtask data
 * recursively.
 *
 * @param token - ClickUp personal API token.
 * @param tasks - Tasks to enrich.
 * @param includeSubtasks - Whether to recursively enrich subtasks.
 * @returns Array of enriched tasks with comments and subtask counts.
 */
async function enrichTasksWithComments(
  token: string,
  tasks: ClickUpTask[],
  includeSubtasks: boolean,
): Promise<ClickUpEnrichedTask[]> {
  const enriched: ClickUpEnrichedTask[] = [];

  for (const task of tasks) {
    if (!task.id) {
      continue;
    }

    const comments = await fetchTaskComments(token, task.id);
    const subtasks = includeSubtasks ? task.subtasks ?? [] : [];

    enriched.push({
      ...task,
      comments,
      subtaskCount: subtasks.length,
      subtasks: includeSubtasks
        ? await enrichTasksWithComments(token, subtasks, false)
        : [],
    });
  }

  return enriched;
}

/**
 * Fetches all comments for a task. Returns an empty array if the request fails.
 *
 * @param token - ClickUp personal API token.
 * @param taskId - The task ID.
 * @returns Array of comments on the task.
 */
async function fetchTaskComments(
  token: string,
  taskId: string,
): Promise<ClickUpComment[]> {
  try {
    const response = await clickUpApi<ClickUpCommentResponse>(
      token,
      `/task/${encodeURIComponent(taskId)}/comment`,
    );
    return response.comments ?? [];
  } catch {
    return [];
  }
}

/**
 * Makes an authenticated request to the ClickUp API with automatic retry and
 * exponential backoff for rate-limited (429) responses.
 *
 * @param token - ClickUp personal API token.
 * @param endpointPath - API path relative to the v2 base URL (e.g. "/team").
 * @param params - Optional query parameters.
 * @returns Parsed JSON response of type `T`.
 * @throws Error if the request fails after all retry attempts.
 */
async function clickUpApi<T>(
  token: string,
  endpointPath: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${CLICKUP_API_BASE_URL}${endpointPath}`);
  for (const [key, value] of Object.entries(removeEmptyValues(params))) {
    url.searchParams.set(key, value);
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const delayMs = retryAfter
        ? Number(retryAfter) * 1000
        : BASE_RETRY_DELAY_MS * Math.pow(2, attempt) + jitter();

      console.warn(
        `[clickup] Rate limited (429) on ${endpointPath}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );

      await sleep(delayMs);
      lastError = new Error(
        `ClickUp API rate limited: ${response.status} ${response.statusText}`,
      );
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `ClickUp API request failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as T;
  }

  throw (
    lastError ??
    new Error(`ClickUp API request failed after ${MAX_RETRIES} retries`)
  );
}

/**
 * Clamps a numeric value to a valid range, returning a fallback if the value
 * is undefined or non-finite.
 *
 * @param value - The value to clamp.
 * @param min - Minimum allowed value.
 * @param max - Maximum allowed value.
 * @param fallback - Fallback value if `value` is invalid.
 * @returns The clamped integer.
 */
function clamp(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
}

/**
 * Removes entries with undefined or empty string values from a record.
 *
 * @param values - Record with potentially empty values.
 * @returns A new record containing only non-empty string values.
 */
function removeEmptyValues(
  values: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].length > 0,
    ),
  );
}

/**
 * Computes the start timestamp for the incremental sync window.
 *
 * @param windowHours - Number of hours to look back.
 * @returns Epoch milliseconds for the window start, or `undefined` if no
 *   window is configured.
 */
function getWindowStartTime(
  windowHours: number | undefined,
): number | undefined {
  if (typeof windowHours !== "number" || !Number.isFinite(windowHours)) {
    return undefined;
  }

  const hours = Math.max(1, Math.min(168, Math.trunc(windowHours)));
  return Date.now() - hours * 60 * 60 * 1000;
}

/**
 * Returns the most recent `date_updated` timestamp across an array of tasks.
 *
 * @param tasks - Array of tasks to inspect.
 * @returns The newest timestamp in epoch milliseconds, or `null` if no tasks
 *   have a valid timestamp.
 */
function getNewestTaskTimestamp(tasks: ClickUpTask[]): number | null {
  let newest = 0;

  for (const task of tasks) {
    const updated = task.date_updated ?? 0;
    if (updated > newest) {
      newest = updated;
    }
  }

  return newest > 0 ? newest : null;
}

/**
 * Returns a random delay in milliseconds (0–999) for jitter in retry logic.
 *
 * @returns Random integer between 0 and 999.
 */
function jitter(): number {
  return Math.floor(Math.random() * 1000);
}

/**
 * Pauses execution for the specified duration.
 *
 * @param ms - Milliseconds to sleep.
 * @returns A promise that resolves after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
