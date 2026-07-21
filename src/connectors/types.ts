export type ConnectorId =
  | "git-repo"
  | "google"
  | "hackernews"
  | "langsmith"
  | "notion"
  | "slack"
  | "web-search"
  | "x";

export type ConnectorBackend =
  "direct-api" | "local-git" | "mcp-http" | "mcp-stdio";

export type ConnectorDefinition = {
  backend: ConnectorBackend;
  description: string;
  displayName: string;
  id: ConnectorId;
  /**
   * Which documentation surface the connector feeds. Code-mode connectors (e.g.
   * langsmith) do not run through personal (local-wiki) ingestion.
   */
  mode: "code" | "personal";
  requiredEnv: string[];
  supportsAgenticDiscovery: boolean;
};

export type ConnectorIngestOptions = {
  connectorConfig?: Record<string, unknown>;
  instanceId?: string;
  limit?: number;
  streams?: string[];
  windowHours?: number;
};

export type ConnectorIngestResult = {
  connectorId: ConnectorId;
  message: string;
  rawFiles: string[];
  runId: string;
  statePath: string;
  status: "error" | "skipped" | "success";
  warnings: string[];
};

export type ConnectorRuntime = ConnectorDefinition & {
  ingest: (options?: ConnectorIngestOptions) => Promise<ConnectorIngestResult>;

  /**
   * Code-mode connectors implement this to contribute to a code-mode agent run:
   * read the repo config, pull data since `since` (the last-update time, or
   * undefined on the first run), and return a guidance block, or undefined when
   * this repo has not configured the connector or there is no new evidence.
   */
  buildCodeModeGuidance?: (
    repoRoot: string,
    since: string | undefined,
  ) => Promise<string | undefined>;
};

export type ConnectorState = {
  lastRunAt?: string;
  latestIds?: Record<string, string>;
  runs?: ConnectorRunSummary[];
  version: 1;
};

export type ConnectorRunSummary = {
  at: string;
  rawFiles: string[];
  runId: string;
  status: ConnectorIngestResult["status"];
  warnings: string[];
};

export type McpConnectorConfig = {
  allowedTools?: string[];
  enabled?: boolean;
  mode?: "mcp-http" | "mcp-stdio";
  transport?: {
    args?: string[];
    command?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    type: "http" | "stdio";
    url?: string;
  };
  readOnlyOperations?: McpReadOnlyOperation[];
};

export type McpReadOnlyOperation = {
  args?: Record<string, unknown>;
  name: string;
  type: "resource" | "tool";
};
