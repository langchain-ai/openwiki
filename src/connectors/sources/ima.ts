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

type ImaConfig = {
  enabled?: boolean;
  knowledgeBaseIds?: string[];
  queries?: string[];
  maxResultsPerKnowledgeBase?: number;
};

type KnowledgeBaseSummary = {
  knowledge_base_id: string;
  name: string;
};

type KnowledgeListItem = {
  media_id: string;
  title: string;
};

const IMA_BASE_URL = "https://ima.qq.com/openapi/wiki/v1";

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches knowledge base entries from IMA (qq.com) using the IMA OpenAPI.",
  displayName: "IMA",
  id: "ima",
  requiredEnv: ["IMA_OPENAPI_CLIENTID", "IMA_OPENAPI_APIKEY"],
  supportsAgenticDiscovery: false,
};

export function createImaConnector(): ConnectorRuntime {
  return {
    ...definition,
    ingest,
  };
}

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = {
    ...(await readConnectorConfig<ImaConfig>("ima", {
      enabled: true,
      knowledgeBaseIds: [],
      queries: [],
      maxResultsPerKnowledgeBase: 20,
    })),
    ...((options.connectorConfig ?? {}) as ImaConfig),
  };
  const state = await readConnectorState("ima");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "ima",
      message:
        "IMA connector is not enabled. Set enabled=true in ~/.openwiki/connectors/ima/config.json.",
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/ima/state.json",
      status: "skipped",
      warnings,
    };
  }

  const clientId = process.env.IMA_OPENAPI_CLIENTID;
  const apiKey = process.env.IMA_OPENAPI_APIKEY;
  if (!clientId || !apiKey) {
    return {
      connectorId: "ima",
      message:
        "Missing IMA credentials. Set IMA_OPENAPI_CLIENTID and IMA_OPENAPI_APIKEY in ~/.openwiki/.env.",
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/ima/state.json",
      status: "error",
      warnings,
    };
  }

  const knowledgeBases = await resolveKnowledgeBases({
    clientId,
    apiKey,
    knowledgeBaseIds: normalizeStringArray(config.knowledgeBaseIds),
    queries: normalizeStringArray(config.queries),
  });

  const maxResults = Math.max(
    1,
    Math.min(100, Math.trunc(config.maxResultsPerKnowledgeBase ?? 20)),
  );

  const knowledgeBaseResults = [];
  for (const knowledgeBase of knowledgeBases) {
    try {
      const list = await getKnowledgeList({
        clientId,
        apiKey,
        knowledgeBaseId: knowledgeBase.knowledge_base_id,
        limit: maxResults,
      });

      const items: Array<{
        media_id: string;
        title: string;
        info: unknown;
      }> = [];

      for (const item of list.slice(0, maxResults)) {
        if (item.media_type === 99) {
          continue;
        }
        try {
          const info = await getMediaInfo({
            clientId,
            apiKey,
            mediaId: item.media_id,
          });
          items.push({
            media_id: item.media_id,
            title: item.title,
            info,
          });
        } catch (error) {
          warnings.push(
            `${knowledgeBase.name} / ${item.title}: ${getErrorMessage(error)}`,
          );
        }
      }

      knowledgeBaseResults.push({
        knowledgeBaseId: knowledgeBase.knowledge_base_id,
        knowledgeBaseName: knowledgeBase.name,
        items,
      });
    } catch (error) {
      warnings.push(
        `${knowledgeBase.name}: ${getErrorMessage(error)}`,
      );
    }
  }

  rawFiles.push(
    await writeRawJson("ima", runId, "ima-results.json", {
      fetchedAt: new Date().toISOString(),
      instanceId: options.instanceId,
      knowledgeBases: knowledgeBaseResults,
      knowledgeBaseSummaries: knowledgeBases,
      queries: normalizeStringArray(config.queries),
      warnings,
      windowHours: options.windowHours,
    }),
  );

  await writeConnectorState(
    "ima",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status: rawFiles.length > 0 ? "success" : "skipped",
      warnings,
    }),
  );

  return {
    connectorId: "ima",
    message: `Fetched ${knowledgeBaseResults.length} IMA knowledge base(s).`,
    rawFiles,
    runId,
    statePath: "~/.openwiki/connectors/ima/state.json",
    status: rawFiles.length > 0 ? "success" : "skipped",
    warnings,
  };
}

async function resolveKnowledgeBases({
  apiKey,
  clientId,
  knowledgeBaseIds,
  queries,
}: {
  clientId: string;
  apiKey: string;
  knowledgeBaseIds: string[];
  queries: string[];
}): Promise<KnowledgeBaseSummary[]> {
  const summaries: KnowledgeBaseSummary[] = [];
  const seen = new Set<string>();

  if (knowledgeBaseIds.length === 0 && queries.length === 0) {
    const response = await imaApi<{ info_list: KnowledgeBaseSummary[] }>(
      clientId,
      apiKey,
      "search_knowledge_base",
      { query: "", limit: 20 },
    );
    for (const item of response.info_list ?? []) {
      if (!seen.has(item.knowledge_base_id)) {
        seen.add(item.knowledge_base_id);
        summaries.push(item);
      }
    }
    return summaries;
  }

  for (const knowledgeBaseId of knowledgeBaseIds) {
    if (!seen.has(knowledgeBaseId)) {
      seen.add(knowledgeBaseId);
      summaries.push({ knowledge_base_id: knowledgeBaseId, name: knowledgeBaseId });
    }
  }

  for (const query of queries) {
    const response = await imaApi<{ info_list: KnowledgeBaseSummary[] }>(
      clientId,
      apiKey,
      "search_knowledge_base",
      { query, limit: 20 },
    );
    for (const item of response.info_list ?? []) {
      if (!seen.has(item.knowledge_base_id)) {
        seen.add(item.knowledge_base_id);
        summaries.push(item);
      }
    }
  }

  return summaries;
}

async function getKnowledgeList({
  apiKey,
  clientId,
  knowledgeBaseId,
  limit,
}: {
  apiKey: string;
  clientId: string;
  knowledgeBaseId: string;
  limit: number;
}): Promise<KnowledgeListItem[]> {
  if (!knowledgeBaseId || knowledgeBaseId.trim().length === 0) {
    return [];
  }
  const response = await imaApi<{ knowledge_list: KnowledgeListItem[] }>(
    clientId,
    apiKey,
    "get_knowledge_list",
    {
      knowledge_base_id: knowledgeBaseId,
      cursor: "",
      limit,
    },
  );
  return response.knowledge_list ?? [];
}

async function getMediaInfo({
  apiKey,
  clientId,
  mediaId,
}: {
  apiKey: string;
  clientId: string;
  mediaId: string;
}): Promise<unknown> {
  return imaApi(clientId, apiKey, "get_media_info", { media_id: mediaId });
}

async function imaApi<T>(
  clientId: string,
  apiKey: string,
  endpoint: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(`${IMA_BASE_URL}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ima-openapi-clientid": clientId,
      "ima-openapi-apikey": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `IMA API ${endpoint} request failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    code: number;
    msg?: string;
    data?: T;
  };

  if (data.code !== 0) {
    throw new Error(
      `IMA API ${endpoint} failed: ${data.code} ${data.msg ?? "unknown error"}`,
    );
  }

  return data.data as T;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
