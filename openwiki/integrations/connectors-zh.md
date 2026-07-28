---
type: 集成
title: OpenWiki 连接器
description: OpenWiki 的七个内置连接器从 Git 仓库、Gmail、Hacker News、Notion、Slack、Web Search 和 X 摄取数据到本地原始缓存以合成 wiki。此参考文档记录了连接器架构、只读 MCP 保障、摄取编排和特定源行为。
tags: [connectors, integrations, ingestion, mcp]
---

OpenWiki 内置七个连接器，将外部数据拉取到 `~/.openwiki/connectors/<id>/raw/` 下的本地原始缓存中，文档代理随后读取并合成 wiki 页面（主要用于 personal/local-wiki 模式；当文档化与摄取源不同的目标仓库时，`git-repo` 对 code 模式也很重要）。

## 连接器架构

所有连接器共享 `src/connectors/types.ts` 中的类型：

- `ConnectorId` — 已实现连接器 id 的联合类型：`"git-repo" | "google" | "hackernews" | "notion" | "slack" | "web-search" | "x"`。此联合类型是当前存在什么的真实来源。
- `ConnectorBackend` — `"direct-api" | "local-git" | "mcp-http" | "mcp-stdio"`。
- `ConnectorDefinition` / `ConnectorRuntime` — id、显示名称、描述、必需环境变量名、连接器是否支持代理发现（让代理决定获取什么）vs. 确定性摄取，以及一个 `ingest()` 函数。
- `ConnectorIngestResult` — `{ status: "success" | "skipped" | "error", rawFiles, warnings, runId, statePath, message }`。
- `ConnectorState` — 每个连接器的游标/去重记录（`lastRunAt`、`latestIds`、最近 20 次 `runs`），持久化在 `~/.openwiki/connectors/<id>/state.json`。

`src/connectors/registry.ts`（`createConnectorRegistry()`）连接全部七个；`notion` 通过通用 `createMcpConnector()` 工厂（`src/connectors/sources/mcp.ts`）构建，而非专门的源文件。

共享 IO 助手位于 `src/connectors/io.ts`：`writeRawJson()` 以 `0600`/`0700` 权限将原始转储写入 `~/.openwiki/connectors/<id>/raw/<runId>/`，`updateStateWithRun()` 维护状态文件。

### 弹性 HTTP（`fetchWithResilience`）

`src/connectors/http.ts` 导出 `fetchWithResilience()`，一个全局 `fetch` 的共享包装器，被每个 direct-API 连接器（Gmail、Hacker News、Slack、X）和 HTTP MCP 客户端（`mcp-client.ts`）使用。它添加了：

- 通过 `AbortSignal.timeout` 的每请求墙上时钟超时（默认 30 秒），与调用者提供的任何 abort 信号组合，因此先触发的那个生效；
- 有界指数退避加完全抖动（基准 500 毫秒，上限 20 秒），用于可重试响应——HTTP 429 和 5xx——当存在时遵循数字或 HTTP 日期 `Retry-After` 头；
- 网络错误（连接重置、DNS、超时）使用相同的退避。

非瞬态响应（2xx、3xx 和 4xx，包括 401/403）在首次尝试后原样返回。认证失败必须到达调用者以便 Gmail 触发 token 刷新；重试它们会浪费尝试并可能导致账户锁定。该助手接受可注入的 `sleep` 和 `random` 函数以进行确定性测试。

面向代理的工具（`src/connectors/tools.ts`）在运行期间将其暴露给 LLM：`openwiki_list_connectors`、`openwiki_list_mcp_tools`、`openwiki_call_mcp_tool`、`openwiki_ingest_connector`、`openwiki_ingest_all_connectors`、`openwiki_list_raw_items`、`openwiki_read_raw_item`。原始文件读取被沙箱化以留在每个连接器的 `raw/` 目录中，必需环境状态仅以布尔值报告——密钥值永远不会暴露给模型。

## MCP 子系统

`src/connectors/mcp-client.ts` 是一个低级 JSON-RPC MCP 客户端（stdio 或 HTTP 传输），实现 `listMcpTools`/`executeMcpTool`/`executeMcpReadOnlyOperations`。`src/connectors/mcp-runtime.ts` 为连接器使用包装它（目前仅 `notion`），添加了**只读工具调用策略**：只有在以下情况下才允许工具调用——它显式列在 `allowedTools` 中、MCP 服务器自身的 `readOnlyHint` 注解为 `true`，或（专门针对托管的 `mcp.notion.com/mcp` 端点）工具名称/描述匹配只读启发式规则（search/retrieve/get/list/query/read/fetch/find/lookup/load/children）。这是即使底层服务器可能暴露写入工具也能保持 MCP 支持的连接器只读的机制。

## 七个连接器

| 连接器           | 后端                           | 必需环境变量                                             | 代理发现 | 拉取什么                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------ | -------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git-repo`       | local-git                      | 无                                                       | 是      | 连接器配置中的本地仓库（`repos: [{id, path}]`）：branch/HEAD、`git log`（最近 20 条，name-status）、`git status --short`、`git diff --name-status HEAD`。写入 `manifest.json`。                                                                           |
| `google` (Gmail) | direct-api                     | Gmail OAuth access/refresh token 环境变量键                | 否       | Gmail API v1 消息；默认查询 `newer_than:1d`，可配置 label/format/headers。写入 `gmail-messages.json`。                                                                                                                                                    |
| `hackernews`     | direct-api                     | 无                                                       | 否       | 公开 HN Firebase feeds（`top`/`new`/`best`/`show`/`ask`/`job`）加 Algolia `search_by_date` 查询。写入 `hackernews-results.json`。                                                                                                                                 |
| `notion`         | mcp-stdio（标签；可能为 HTTP） | `OPENWIKI_NOTION_MCP_ACCESS_TOKEN`                       | 是      | 托管 Notion MCP 服务器（或已配置 MCP 传输）；发现工具（`mcp-tools.json`）或执行已配置的只读操作（`mcp-results.json`）。                                                                                                              |
| `slack`          | direct-api                     | Slack user-token 环境变量键                                 | 否       | `auth.test` 身份、`search.messages` 自消息搜索、有界 `conversations.list`/`.history` 回退、`assistant.search.context`。写入 `identity.json`、`my-messages-search.json`、`recent-messages.json`、`my-recent-messages.json`、`assistant-search.json`。 |
| `web-search`     | direct-api                     | `TAVILY_API_KEY`（通过 `OPENWIKI_TAVILY_API_KEY_ENV_KEY`） | 否       | 为已配置查询进行 Tavily 搜索（`@langchain/tavily`）。写入 `web-search-results.json`。                                                                                                                                                                             |
| `x`              | direct-api                     | X OAuth user-context access token 环境变量键                | 否       | X API v2：`home_timeline`、`user_posts`、`mentions`、`bookmarks`、`list_posts` 流，按每流 `since_id` 游标分页（bookmarks 总是重新拉取）。每个流/列表写入一个 JSON 文件。                                                                  |

### 值得注意的连接器特定行为

- **Slack 和"最新消息"问题**：`my-recent-messages.json` 包含一个 `definitiveForLatestMessage` 标志。它仅在最新消息通过 `search.messages` 解析时为 `true`（需要 `search:read` user-token scope）。如果该搜索不可用，连接器回退到有界 `conversations.history` 扫描，设置 `definitiveForLatestMessage: false`，并警告结果不可靠地是用户真正的最新 Slack 消息。在从原始 Slack 数据回答"我最后在 Slack 上说了什么"之前，始终检查此标志。
- **X 流和游标**：每个流（`bookmarks` 除外）在连接器状态中跟踪 `since_id` 游标，因此重复摄取运行是增量的；`list_posts` 按已配置的 `listIds` 展开。
- **Notion 在配置前被禁用**：在摄取执行除工具发现之外的任何操作之前，必须在连接器配置中设置 `enabled: true` 加传输。
- **git-repo 对读取访问没有摄取与代理的区分**：它是唯一标记为 `supportsAgenticDiscovery: true` 的连接器（与 `notion` 并列），因为 git checkout 可以自由探索而非通过有界 API 拉取。

## 摄取编排

`src/ingestion.ts`（`runOpenWikiIngestion`）加载 `~/.openwiki/.env`，读取引导配置，构建连接器注册表，并解析目标——`"all"`、裸 `ConnectorId` 或特定源实例 id（连接器可以配置多次，例如 `web-search-1`/`web-search-2`，通过 `openwiki ingest web-search-2` 单独运行）。对于每个匹配的实例，它首先运行确定性摄取（写入原始 JSON + 更新状态），然后合成代理运行读取这些原始文件来更新 wiki。这种分割——确定性获取，然后 LLM 合成——将凭证网络调用排除在模型控制的代码路径之外。

## 引导和计划

`src/onboarding.ts` 驱动首次运行设置：wiki 模板选择、范围自定义、每源摄取笔记和源计划，持久化到 `~/.openwiki/onboarding.json`。全局个人 wiki 指令保存到 `~/.openwiki/INSTRUCTIONS.md`。

`src/schedules.ts` 将源计划安装为 macOS 用户 LaunchAgent（`~/Library/LaunchAgents/`），日志在 `~/.openwiki/logs/` 下，并支持 `openwiki cron list|pause|resume|delete` 命令（参见 [CLI 用法](/cli/usage.md)）。

## 更改连接器行为时的注意事项

- 添加连接器意味着：扩展 `types.ts` 中的 `ConnectorId`，在 `src/connectors/sources/` 下添加源文件，在 `registry.ts` 中注册，并在 `src/credentials.tsx` 引导中添加其 `SOURCE_OPTIONS` 条目——参见 `/skills/write-connector/SKILL.md` 获取完整清单。
- 绝不将密钥值写入连接器配置或原始转储——仅环境变量名和存在布尔值。
- 将确定性摄取（网络调用）排除在代理控制的代码之外；代理只读取摄取已写入 `raw/` 的内容。
- MCP 连接器必须保持只读；对 `mcp-runtime.ts` 工具调用策略的更改直接影响托管 MCP 服务器被允许代表 OpenWiki 做什么。

# 引用

- `src/connectors/types.ts`, `src/connectors/registry.ts`, `src/connectors/io.ts`, `src/connectors/http.ts`, `src/connectors/tools.ts`
- `src/connectors/mcp-client.ts`, `src/connectors/mcp-runtime.ts`, `src/connectors/sources/mcp.ts`
- `src/connectors/sources/git-repo.ts`, `src/connectors/sources/gmail.ts`, `src/connectors/sources/hackernews.ts`, `src/connectors/sources/slack.ts`, `src/connectors/sources/web-search.ts`, `src/connectors/sources/x.ts`
- `src/ingestion.ts`, `src/onboarding.ts`, `src/schedules.ts`
- `LANGSMITH-CONNECTOR.md`, `CODING-AGENTS-CONNECTOR.md`
- `test/onboarding.test.ts`
