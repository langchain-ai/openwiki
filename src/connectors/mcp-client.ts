import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { OPENWIKI_VERSION } from "../constants.js";
import {
  getOAuthAccessToken,
  getOAuthProviderIdForAccessTokenEnvKey,
} from "../auth/tokens.js";
import type { McpConnectorConfig, McpReadOnlyOperation } from "./types.js";

type JsonRpcRequest = {
  id?: number;
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  error?: {
    code?: number;
    message?: string;
  };
  id?: number;
  result?: unknown;
};

export type McpExecutionResult = {
  operations: {
    name: string;
    result: unknown;
    type: McpReadOnlyOperation["type"];
  }[];
  transport: {
    command?: string;
    type: "http" | "stdio";
    url?: string;
  };
};

export type McpToolListResult = {
  tools: McpToolDescriptor[];
  transport: {
    command?: string;
    type: "http" | "stdio";
    url?: string;
  };
};

export type McpToolDescriptor = {
  annotations?: Record<string, unknown>;
  description?: string;
  inputSchema?: unknown;
  name: string;
};

export async function executeMcpReadOnlyOperations(
  config: McpConnectorConfig,
): Promise<McpExecutionResult> {
  validateMcpConfig(config);

  if (config.transport?.type === "stdio") {
    return executeStdioMcp(config);
  }

  return executeHttpMcp(config);
}

export async function listMcpTools(
  config: McpConnectorConfig,
): Promise<McpToolListResult> {
  validateMcpTransport(config);

  if (config.transport?.type === "stdio") {
    return listStdioMcpTools(config);
  }

  return listHttpMcpTools(config);
}

export async function executeMcpTool(
  config: McpConnectorConfig,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  validateMcpTransport(config);
  validateMcpOperationName(name);
  validateMcpArgs(args);

  if (config.transport?.type === "stdio") {
    return executeStdioMcpTool(config, name, args);
  }

  return executeHttpMcpTool(config, name, args);
}

function validateMcpConfig(config: McpConnectorConfig): void {
  validateMcpTransport(config);

  if (
    !Array.isArray(config.readOnlyOperations) ||
    config.readOnlyOperations.length === 0
  ) {
    throw new Error("MCP config requires at least one readOnlyOperation.");
  }

  for (const operation of config.readOnlyOperations) {
    validateMcpOperation(operation);
  }
}

function validateMcpOperation(operation: McpReadOnlyOperation): void {
  if (operation.type !== "resource" && operation.type !== "tool") {
    throw new Error(`Invalid MCP operation type: ${String(operation.type)}`);
  }

  if (operation.type === "tool") {
    validateMcpOperationName(operation.name);
    return;
  }

  const uri =
    typeof operation.args?.uri === "string"
      ? operation.args.uri
      : operation.name;

  if (!uri) {
    throw new Error(
      "MCP resource operation requires a resource URI in name or args.uri.",
    );
  }

  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(uri)) {
    throw new Error(`Invalid MCP resource URI: ${uri}`);
  }
}

function validateMcpOperationName(name: string): void {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9._:/#?=&-]{1,300}$/u.test(name)
  ) {
    throw new Error(`Invalid MCP operation name: ${name}`);
  }
}

function validateMcpArgs(args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    if (!/^[A-Za-z0-9._-]{1,200}$/u.test(key)) {
      throw new Error(`Invalid MCP tool argument name: ${key}`);
    }
  }
}

function validateMcpTransport(config: McpConnectorConfig): void {
  if (!config.transport) {
    throw new Error("MCP config requires a transport.");
  }
}

async function executeStdioMcp(
  config: McpConnectorConfig,
): Promise<McpExecutionResult> {
  const transport = config.transport;

  if (transport?.type !== "stdio" || !transport.command) {
    throw new Error("stdio MCP transport requires a command.");
  }

  validateCommand(transport.command);
  for (const arg of transport.args ?? []) {
    validateCommandArg(arg);
  }

  const child = spawn(transport.command, transport.args ?? [], {
    env: {
      ...process.env,
      ...resolveChildEnv(transport.env ?? {}),
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new StdioJsonRpcClient(child);

  try {
    await client.initialize();
    const operations = [];

    for (const operation of config.readOnlyOperations ?? []) {
      operations.push({
        name: operation.name,
        result: await client.executeOperation(operation),
        type: operation.type,
      });
    }

    return {
      operations,
      transport: {
        command: transport.command,
        type: "stdio",
      },
    };
  } finally {
    client.close();
  }
}

async function executeStdioMcpTool(
  config: McpConnectorConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const transport = config.transport;

  if (transport?.type !== "stdio" || !transport.command) {
    throw new Error("stdio MCP transport requires a command.");
  }

  validateCommand(transport.command);
  for (const arg of transport.args ?? []) {
    validateCommandArg(arg);
  }

  const child = spawn(transport.command, transport.args ?? [], {
    env: {
      ...process.env,
      ...resolveChildEnv(transport.env ?? {}),
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new StdioJsonRpcClient(child);

  try {
    await client.initialize();
    return await client.executeOperation({
      args,
      name,
      type: "tool",
    });
  } finally {
    client.close();
  }
}

async function listStdioMcpTools(
  config: McpConnectorConfig,
): Promise<McpToolListResult> {
  const transport = config.transport;

  if (transport?.type !== "stdio" || !transport.command) {
    throw new Error("stdio MCP transport requires a command.");
  }

  validateCommand(transport.command);
  for (const arg of transport.args ?? []) {
    validateCommandArg(arg);
  }

  const child = spawn(transport.command, transport.args ?? [], {
    env: {
      ...process.env,
      ...resolveChildEnv(transport.env ?? {}),
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new StdioJsonRpcClient(child);

  try {
    await client.initialize();

    return {
      tools: extractTools(await client.listTools()),
      transport: {
        command: transport.command,
        type: "stdio",
      },
    };
  } finally {
    client.close();
  }
}

async function executeHttpMcp(
  config: McpConnectorConfig,
): Promise<McpExecutionResult> {
  const transport = config.transport;

  if (transport?.type !== "http" || !transport.url) {
    throw new Error("HTTP MCP transport requires a URL.");
  }

  const url = validateMcpUrl(transport.url);
  const client = new HttpJsonRpcClient(
    url,
    await resolveHeaders(transport.headers ?? {}),
  );
  await client.initialize();

  const operations = [];
  for (const operation of config.readOnlyOperations ?? []) {
    operations.push({
      name: operation.name,
      result: await client.executeOperation(operation),
      type: operation.type,
    });
  }

  return {
    operations,
    transport: {
      type: "http",
      url,
    },
  };
}

async function executeHttpMcpTool(
  config: McpConnectorConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const transport = config.transport;

  if (transport?.type !== "http" || !transport.url) {
    throw new Error("HTTP MCP transport requires a URL.");
  }

  const url = validateMcpUrl(transport.url);
  const client = new HttpJsonRpcClient(
    url,
    await resolveHeaders(transport.headers ?? {}),
  );
  await client.initialize();

  return await client.executeOperation({
    args,
    name,
    type: "tool",
  });
}

async function listHttpMcpTools(
  config: McpConnectorConfig,
): Promise<McpToolListResult> {
  const transport = config.transport;

  if (transport?.type !== "http" || !transport.url) {
    throw new Error("HTTP MCP transport requires a URL.");
  }

  const url = validateMcpUrl(transport.url);
  const client = new HttpJsonRpcClient(
    url,
    await resolveHeaders(transport.headers ?? {}),
  );
  await client.initialize();

  return {
    tools: extractTools(await client.listTools()),
    transport: {
      type: "http",
      url,
    },
  };
}

function extractTools(value: unknown): McpToolDescriptor[] {
  return extractToolValues(value)
    .map(normalizeMcpTool)
    .filter((tool): tool is McpToolDescriptor => tool !== null);
}

function extractToolValues(value: unknown): unknown[] {
  if (
    value !== null &&
    typeof value === "object" &&
    "tools" in value &&
    Array.isArray(value.tools)
  ) {
    return value.tools;
  }

  return [];
}

function normalizeMcpTool(value: unknown): McpToolDescriptor | null {
  if (value === null || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string") {
    return null;
  }

  try {
    validateMcpOperationName(record.name);
  } catch {
    return null;
  }

  return {
    annotations:
      record.annotations !== null && typeof record.annotations === "object"
        ? (record.annotations as Record<string, unknown>)
        : undefined,
    description:
      typeof record.description === "string" ? record.description : undefined,
    inputSchema: record.inputSchema,
    name: record.name,
  };
}

class StdioJsonRpcClient {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      reject: (error: Error) => void;
      resolve: (value: unknown) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.flushLines();
    });
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => {
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("exit", (code, signal) => {
      this.rejectAll(
        new Error(
          `MCP stdio process exited early: code=${code} signal=${signal}`,
        ),
      );
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      capabilities: {},
      clientInfo: {
        name: "openwiki",
        version: OPENWIKI_VERSION,
      },
      protocolVersion: "2025-06-18",
    });
    this.notify("notifications/initialized");
  }

  executeOperation(operation: McpReadOnlyOperation): Promise<unknown> {
    if (operation.type === "tool") {
      return this.request("tools/call", {
        arguments: operation.args ?? {},
        name: operation.name,
      });
    }

    return this.request("resources/read", {
      uri: getResourceUri(operation),
    });
  }

  listTools(): Promise<unknown> {
    return this.request("tools/list", {});
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
    }
    this.pending.clear();
    this.child.stdin.end();
    setTimeout(() => {
      if (this.child.exitCode === null) {
        this.child.kill();
      }
    }, 1_000).unref();
  }

  private notify(method: string): void {
    this.write({
      jsonrpc: "2.0",
      method,
    });
  }

  private request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;

    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for MCP response to ${method}.`));
      }, 60_000);

      this.pending.set(id, {
        reject,
        resolve,
        timeout,
      });
    });

    this.write({
      id,
      jsonrpc: "2.0",
      method,
      params,
    });

    return promise;
  }

  private write(message: JsonRpcRequest): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private flushLines(): void {
    let newlineIndex = this.buffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        this.handleLine(line);
      }

      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }

    if (typeof response.id !== "number") {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(
        new Error(response.error.message ?? "MCP request failed."),
      );
      return;
    }

    pending.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

class HttpJsonRpcClient {
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  async initialize(): Promise<void> {
    await this.request("initialize", {
      capabilities: {},
      clientInfo: {
        name: "openwiki",
        version: OPENWIKI_VERSION,
      },
      protocolVersion: "2025-06-18",
    });
    await this.notify("notifications/initialized");
  }

  executeOperation(operation: McpReadOnlyOperation): Promise<unknown> {
    if (operation.type === "tool") {
      return this.request("tools/call", {
        arguments: operation.args ?? {},
        name: operation.name,
      });
    }

    return this.request("resources/read", {
      uri: getResourceUri(operation),
    });
  }

  listTools(): Promise<unknown> {
    return this.request("tools/list", {});
  }

  private async notify(method: string): Promise<void> {
    await this.post({
      jsonrpc: "2.0",
      method,
    });
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const response = await this.post({
      id,
      jsonrpc: "2.0",
      method,
      params,
    });

    if (response.error) {
      throw new Error(response.error.message ?? "MCP request failed.");
    }

    return response.result;
  }

  private async post(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const response = await fetch(this.url, {
      body: JSON.stringify(message),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
        ...this.headers,
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      method: "POST",
    });

    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      this.sessionId = sessionId;
    }

    if (response.status === 202) {
      return {};
    }

    if (!response.ok) {
      throw new Error(`MCP HTTP request failed: ${response.status}`);
    }

    return parseHttpMcpResponse(
      await response.text(),
      response.headers.get("content-type") ?? "",
    );
  }
}

function parseHttpMcpResponse(
  content: string,
  contentType: string,
): JsonRpcResponse {
  if (content.trim().length === 0) {
    return {};
  }

  if (contentType.includes("text/event-stream")) {
    for (const eventData of parseSseDataLines(content)) {
      const response = JSON.parse(eventData) as JsonRpcResponse;
      if (
        response.id !== undefined ||
        response.result !== undefined ||
        response.error
      ) {
        return response;
      }
    }

    return {};
  }

  return JSON.parse(content) as JsonRpcResponse;
}

function parseSseDataLines(content: string): string[] {
  const events: string[] = [];
  let current = "";

  for (const line of content.split(/\r?\n/u)) {
    if (line.startsWith("data:")) {
      current += line.slice("data:".length).trim();
    } else if (line.trim().length === 0 && current.length > 0) {
      events.push(current);
      current = "";
    }
  }

  if (current.length > 0) {
    events.push(current);
  }

  return events;
}

function resolveChildEnv(
  envRefs: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(envRefs).map(([key, value]) => {
      validateEnvKey(key);
      return [key, resolveEnvReference(value)];
    }),
  );
}

async function resolveHeaders(
  headers: Record<string, string>,
): Promise<Record<string, string>> {
  const resolvedEntries: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(headers)) {
    resolvedEntries.push([
      validateHeaderName(key),
      await resolveTemplateEnvReferences(value, key),
    ]);
  }

  return Object.fromEntries(resolvedEntries);
}

async function resolveTemplateEnvReferences(
  value: string,
  key: string,
): Promise<string> {
  if (!value.includes("${")) {
    if (
      /(token|secret|authorization|api[-_]?key|bearer)/iu.test(
        `${key} ${value}`,
      )
    ) {
      throw new Error(
        `Header ${key} must reference credentials with \${ENV_VAR}, not a literal value.`,
      );
    }

    return value;
  }

  let resolvedValue = value;
  const envRefs = value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/gu);

  for (const match of envRefs) {
    const envKey = match[1];
    const envValue = await resolveHeaderEnvReference(envKey);
    resolvedValue = resolvedValue.replace(match[0], envValue);
  }

  return resolvedValue;
}

async function resolveHeaderEnvReference(envKey: string): Promise<string> {
  validateEnvKey(envKey);

  const providerId = getOAuthProviderIdForAccessTokenEnvKey(envKey);
  if (providerId) {
    return await getOAuthAccessToken(providerId);
  }

  return resolveEnvReference(envKey);
}

function resolveEnvReference(value: string): string {
  const envKey =
    value.startsWith("${") && value.endsWith("}") ? value.slice(2, -1) : value;

  validateEnvKey(envKey);
  const envValue = process.env[envKey];

  if (!envValue) {
    throw new Error(`${envKey} is required for MCP connector ingestion.`);
  }

  return envValue;
}

function getResourceUri(operation: McpReadOnlyOperation): string {
  const uri =
    typeof operation.args?.uri === "string"
      ? operation.args.uri
      : operation.name;

  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(uri)) {
    throw new Error(`Invalid MCP resource URI: ${uri}`);
  }

  return uri;
}

function validateCommand(command: string): void {
  if (!/^[A-Za-z0-9._/@+-]{1,300}$/u.test(command)) {
    throw new Error(`Invalid MCP stdio command: ${command}`);
  }
}

function validateCommandArg(arg: string): void {
  if (
    Array.from(arg).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 0 || codePoint === 10 || codePoint === 13;
    })
  ) {
    throw new Error(
      "MCP stdio command args must not contain control characters.",
    );
  }
}

function validateEnvKey(key: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(key)) {
    throw new Error(`Invalid env var reference: ${key}`);
  }

  return key;
}

function validateHeaderName(key: string): string {
  if (!/^[A-Za-z0-9-]{1,100}$/u.test(key)) {
    throw new Error(`Invalid HTTP header name: ${key}`);
  }

  return key;
}

function validateMcpUrl(value: string): string {
  const url = new URL(value);
  const isLocalhost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";

  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new Error("HTTP MCP URLs must use https, except localhost http.");
  }

  return url.toString();
}
