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

type ClickUpConfig = {
  enabled?: boolean;
  folderIds?: string[];
  includeSubtasks?: boolean;
  listIds?: string[];
  maxTasksPerList?: number;
  spaceIds?: string[];
  taskFields?: string[];
  windowHours?: number;
  workspaceIds?: string[];
};

type ClickUpWorkspace = {
  id?: string;
  name?: string;
};

type ClickUpSpace = {
  id?: string;
  name?: string;
  private?: boolean;
};

type ClickUpList = {
  id?: string;
  name?: string;
  orderindex?: number;
  space?: { id?: string };
};

type ClickUpTask = {
  assignees?: ClickUpAssignee[];
  custom_fields?: ClickUpCustomField[];
  date_closed?: number | null;
  date_created?: number;
  date_done?: number | null;
  date_updated?: number;
  description?: string;
  due_date?: number | null;
  id?: string;
  links_to?: string | null;
  markdown_description?: string;
  name?: string;
  orderindex?: number;
  priority?: ClickUpPriority;
  status?: ClickUpStatus;
  subtasks?: ClickUpTask[];
  tags?: ClickUpTag[];
  text_content?: string;
  url?: string;
};

type ClickUpAssignee = {
  color?: string;
  email?: string;
  id?: number;
  profilePhoto?: string;
  username?: string;
};

type ClickUpCustomField = {
  id?: string;
  name?: string;
  type_config?: {
    options?: { id?: string; label?: string; orderindex?: number }[];
  };
  value?: unknown;
};

type ClickUpPriority = {
  color?: string;
  id?: string;
  orderindex?: number;
  priority?: string;
};

type ClickUpStatus = {
  color?: string;
  id?: string;
  status?: string;
  type?: string;
};

type ClickUpTag = {
  color?: string;
  creator?: number;
  id?: string;
  name?: string;
  orderindex?: number;
};

type ClickUpComment = {
  comment_text?: string;
  date?: string;
  id?: string;
  text_content?: string;
  user?: ClickUpCommentUser;
};

type ClickUpCommentUser = {
  email?: string;
  id?: number;
  username?: string;
};

type ClickUpTaskPage = {
  tasks?: ClickUpTask[];
};

const CLICKUP_API_BASE_URL = "https://api.clickup.com/api/v2";
const DEFAULT_MAX_TASKS_PER_LIST = 100;
const DEFAULT_WINDOW_HOURS = 168;

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches ClickUp workspaces, tasks, subtasks, comments, and docs through the ClickUp API v2 with a personal API token.",
  displayName: "ClickUp",
  id: "clickup",
  requiredEnv: [OPENWIKI_CLICKUP_API_TOKEN_ENV_KEY],
  supportsAgenticDiscovery: false,
};

export function createClickUpConnector(): ConnectorRuntime {
  return {
    ...definition,
    ingest,
  };
}

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

async function fetchWorkspaces(
  token: string,
): Promise<ClickUpWorkspace[]> {
  const response = await clickUpApi<ClickUpWorkspaceResponse>(token, "/team");
  return response.teams ?? [];
}

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

  const response = await clickUpApi<ClickUpSpaceResponse>(
    token,
    `/team/${encodeURIComponent(workspaceId)}/space`,
  );
  return response.spaces ?? [];
}

async function fetchListsForSpace(
  token: string,
  spaceId: string,
): Promise<ClickUpList[]> {
  const response = await clickUpApi<ClickUpListResponse>(
    token,
    `/space/${encodeURIComponent(spaceId)}/list`,
  );
  return response.lists ?? [];
}

async function fetchTasksForList(
  token: string,
  listId: string,
  options: {
    maxTasksPerList: number;
    sinceDate: number | undefined;
  },
): Promise<ClickUpTask[]> {
  const params: Record<string, string> = {
    page: "0",
    subtasks: "true",
    include_closed: "true",
  };

  if (options.sinceDate !== undefined) {
    params.order_by = "updated";
    // ClickUp uses date_updated for ordering; we filter after fetching
  }

  const response = await clickUpApi<ClickUpTaskPage>(
    token,
    `/list/${encodeURIComponent(listId)}/task`,
    params,
  );

  let tasks = response.tasks ?? [];

  if (options.sinceDate !== undefined) {
    tasks = tasks.filter(
      (task) =>
        (task.date_updated ?? 0) > options.sinceDate! ||
        (task.date_created ?? 0) > options.sinceDate!,
    );
  }

  return tasks.slice(0, options.maxTasksPerList);
}

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

async function clickUpApi<T>(
  token: string,
  endpointPath: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${CLICKUP_API_BASE_URL}${endpointPath}`);
  for (const [key, value] of Object.entries(removeEmptyValues(params))) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `ClickUp API request failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as T;
}

type ClickUpWorkspaceResponse = {
  teams?: ClickUpWorkspace[];
};

type ClickUpSpaceResponse = {
  spaces?: ClickUpSpace[];
};

type ClickUpListResponse = {
  lists?: ClickUpList[];
};

type ClickUpCommentResponse = {
  comments?: ClickUpComment[];
};

type ClickUpEnrichedTask = ClickUpTask & {
  comments: ClickUpComment[];
  subtaskCount: number;
  subtasks: ClickUpEnrichedTask[];
};

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

function getWindowStartTime(
  windowHours: number | undefined,
): number | undefined {
  if (typeof windowHours !== "number" || !Number.isFinite(windowHours)) {
    return undefined;
  }

  const hours = Math.max(1, Math.min(168, Math.trunc(windowHours)));
  return Date.now() - hours * 60 * 60 * 1000;
}

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
