---
type: 架构概览
title: OpenWiki 架构概览
description: 解释 OpenWiki 的分层 CLI、代理、提供商、连接器、认证和摄取架构，包括运行时执行和持久化。识别核心源码模块、扩展点和维护 OpenWiki 的运维注意事项。
tags: [architecture, cli, agent, providers, connectors, ingestion]
---

# 架构概览

OpenWiki 有一个小巧但分层的架构：

1. `src/cli.tsx` 提供交互式终端应用程序并编排运行，包括 init/update 的自动退出。
2. `src/commands.ts` 解析 argv 并定义帮助文本和支持的选项，包括 `auth`、`ngrok`、`cron` 和 `ingest` 子命令。
3. `src/credentials.tsx` 管理提供商选择、API 密钥、模型选择和可选 LangSmith 追踪的交互式引导。
4. `src/env.ts` 读写 `~/.openwiki/.env` 并为所有支持的提供商提供凭证诊断。
5. `src/agent/index.ts` 运行文档代理，解析提供商，创建适当的模型客户端，收集 Git 上下文，并写入更新元数据。
6. `src/agent/prompt.ts` 构建告诉模型如何行为的 system 和 user prompt。
7. `src/agent/utils.ts` 收集 Git 证据，计算 OpenWiki 内容快照，并在成功的 init/update 运行后记录 `.last-update.json`。
8. `src/agent/docs-only-backend.ts` 提供 `OpenWikiLocalShellBackend`，扩展 DeepAgents `LocalShellBackend`，增加仅文档写入保护和输出模式感知。
9. `src/agent/openai-chatgpt-oauth.ts` 实现 ChatGPT OAuth 登录流程、token 持久化和刷新，用于 `openai-chatgpt` 提供商。
10. `src/auth/` 包含连接器 OAuth 系统：`oauth.ts`（通用 runner）、`providers.ts`（提供商配置）、`configure.ts`（`openwiki auth configure`）、`ngrok.ts`（Slack HTTPS 隧道）、`tokens.ts`（刷新/验证）和 `types.ts`。
11. `src/connectors/` 包含连接器注册表、MCP 客户端/运行时、共享弹性 HTTP 助手（`http.ts`）、特定源的摄取模块（git-repo、gmail、hackernews、slack、web-search、x）以及暴露给代理的工具定义。
12. `src/ingestion.ts` 编排跨已配置连接器的源摄取运行。
13. `src/code-mode.ts` 处理 `openwiki code` 设置：仅在 GitHub Actions 工作流不存在时创建（因此运维自定义能在 `--update` 运行中保留），并就地刷新 AGENTS.md/CLAUDE.md 片段。
14. `src/constants.ts` 集中管理提供商配置、模型选项、环境键、验证助手和 wiki 目录名称。
15. `src/agent/types.ts` 定义共享类型：`OpenWikiCommand`、`RunContext`、`UpdateMetadata` 和运行选项/事件接口。

## 运行时形态

CLI 从 `src/cli.tsx` 启动，解析命令，然后：

- 打印帮助并退出，
- 打开交互式 chat UI，
- 对当前仓库运行 init/update 命令，或
- 在开发模式下执行 dry-run。

对于非 chat 运行，代理接收一个 `RunContext`，其中包含上次更新元数据和从以下生成的 Git 摘要：

- `git status --short`
- `git rev-parse HEAD`
- `git log --max-count=20 --name-status --oneline`（init，或无先前元数据的 update）
- `git log <lastHead>..HEAD --name-status --oneline`（有记录 `gitHead` 的 update）
- `git log --since <updatedAt> --name-status --oneline`（仅有时间戳的 update）
- `git diff --name-status HEAD`

### 提供商和模型解析

代理运行时通过 `src/constants.ts` 中的 `resolveConfiguredProvider()` 解析提供商：

1. 如果 `OPENWIKI_PROVIDER` 已设置且有效，使用它。
2. 否则，按以下顺序使用第一个可用的提供商 API 密钥：OpenAI、OpenAI-compatible、OpenRouter、Anthropic、Baseten、Fireworks、Nebius、NVIDIA，然后是 Bedrock。
3. 否则，回退到 `DEFAULT_PROVIDER`（`openai`）及其默认模型（`gpt-5.6-terra`）。

模型创建在 `src/agent/index.ts`（`createModel`）中按提供商分支：

- **gemini** → `ChatGoogle`，`platformType: "gai"`（AI Studio），使用 Gemini API 密钥。包含 Gemini 3.x thought-signature 往返处理。
- **gemini-enterprise** → `createGeminiEnterpriseModel()`，通过 `src/agent/vertex-surface.ts` 中的 `resolveVertexSurface()` 按模型族路由：Claude 模型使用 `ChatAnthropic` 和自定义 `AnthropicVertex` 客户端（`@anthropic-ai/vertex-sdk`），合作/开源权重模型使用 `ChatOpenAI` 通过 Vertex 的 OpenAI 兼容 MaaS 端点（每请求进行 ADC 认证获取），Gemini/Gemma 模型使用 `ChatGoogle` 和 Google ADC（无密钥，`apiKey:[REDACTED]` 以阻止 `GOOGLE_API_KEY` 回退）。认证为 Google Application Default Credentials；`GOOGLE_CLOUD_PROJECT` 是必需的，`GOOGLE_CLOUD_LOCATION` 是可选的（默认为 `global`）。
- **anthropic** → `ChatAnthropic`，使用 Anthropic API 密钥。
- **openai-chatgpt** → `ChatOpenAI`，`useResponsesApi: true`、`zdrEnabled: true`、`streaming: true`，指向 Codex 后端（`CODEX_RESPONSES_BASE_URL`），带 account-id/originator/beta 头。token 在模型创建前通过 `ensureFreshChatGptTokens()` 刷新。
- **openrouter** → `ChatOpenRouter`，使用选定的模型 ID。
- **bedrock** → `ChatBedrockConverse`（`@langchain/aws`），带 AWS access key ID、secret access key 和必需的 region。
- **openai** → `ChatOpenAI`，`useResponsesApi: true`。
- **baseten / fireworks / nebius / nvidia / openai-compatible** → `ChatOpenAI`，使用提供商的 API 密钥和来自 `PROVIDER_CONFIGS` 的可选自定义 `baseURL`。

模型创建前的凭证门控使用 `src/constants.ts` 中的 `getMissingProviderEnvKey()`，它要求提供商的 API 密钥——或 gemini-enterprise 的 `GOOGLE_CLOUD_PROJECT`——并为 CLI 的非交互式门控和引导流程提供相同的检查。

### DeepAgents 后端

代理使用以仓库为根的 DeepAgents `LocalShellBackend`，配置了 `virtualMode: true`、`maxOutputBytes: 100_000` 和 120 秒超时。SQLite checkpointer（`~/.openwiki/openwiki.sqlite`）按仓库路径哈希持久化对话线程。

### 内容快照和元数据写入

非 chat 运行完成后，`src/agent/utils.ts` 计算 `openwiki/` 目录的 SHA-256 快照（排除 `.last-update.json`）。**仅在快照发生变化时**才写入元数据——一个未触及文档的无操作更新不会更新 `.last-update.json`。这防止了计划工作流中的无限更新循环。

### 自动退出行为

`src/cli.tsx` 中的 `shouldAutoExitStartupRun()` 确定启动运行是否应在成功时自动退出。这适用于在 TTY 中运行（不带 `--print`）的 `--init` 和 `--update` 命令：CLI 启动运行，渲染流式输出，成功时以退出码 0 退出。Chat 运行和 `--print` 运行不受影响。

## 架构为何如此设计

当前设计反映了一个文档产品而非通用代理框架：

- CLI 拥有用户体验和凭证引导，使工具可以即装即用。
- Git 证据在代理启动前在宿主进程中收集，因此模型看到稳定的仓库上下文。
- 提供商支持集中在 `src/constants.ts` 中，因此添加一个提供商只需要一个配置变更加一个模型创建分支。
- 模型执行是提供商稳定的：瞬态请求失败可以通过选定的 LangChain 模型客户端重试，但 OpenWiki 显示最终错误而非用另一个模型继续。
- 内容快照检查防止了更新运行未产生文档变更时的元数据搅动，这对于计划 CI 工作流很重要。
- init/update 的自动退出使 CLI 在交互式和一次性场景中都可使用，无需 `--print`。

## 主要扩展点

- 在 `src/commands.ts` 中添加或优化 CLI 命令，在 `src/cli.tsx` 中修改相应的 UI 行为。
- 在 `src/credentials.tsx` 和 `src/env.ts` 中更改引导或本地凭证存储。
- 通过扩展 `src/constants.ts` 中的 `PROVIDER_CONFIGS` 和 `OpenWikiProvider`，然后在 `src/agent/index.ts` 的 `createModel` 中添加分支来添加新的模型提供商。
- 在 `src/constants.ts` 中调整模型默认值、验证或回退列表。
- 在 `src/agent/prompt.ts` 和 `src/agent/utils.ts` 中扩展文档提示或 Git 证据。
- 在 `src/agent/utils.ts` 中修改运行持久化或快照行为。

## 编辑时的注意事项

- `src/cli.tsx` 和 `src/commands.ts` 必须保持对齐；帮助文本和解析器行为是有意耦合的。
- 凭证设置写入真实的 home 目录文件，因此权限处理很重要。
- 代理应从仓库本地虚拟路径（如 `/README.md` 和 `/openwiki/quickstart.md`）工作；提示明确警告了这一点。
- 目标仓库中的 `openwiki/` 既是文档输出位置，也是 `.last-update.json` 的元数据位置。
- 添加提供商时，更新 `src/env.ts` 中的 `managedEnvKeys`，以便诊断和环境格式化覆盖新的键。
- 内容快照逻辑排除 `.last-update.json`；如果在 `openwiki/` 下添加新的元数据文件，决定是否也应排除它们。

## 源码索引

- `src/cli.tsx`
- `src/commands.ts`
- `src/credentials.tsx`
- `src/env.ts`
- `src/agent/index.ts`
- `src/agent/prompt.ts`
- `src/agent/utils.ts`
- `src/agent/types.ts`
- `src/agent/docs-only-backend.ts`
- `src/agent/openai-chatgpt-oauth.ts`
- `src/auth/oauth.ts`
- `src/auth/providers.ts`
- `src/auth/configure.ts`
- `src/auth/ngrok.ts`
- `src/auth/tokens.ts`
- `src/auth/types.ts`
- `src/connectors/registry.ts`
- `src/connectors/tools.ts`
- `src/connectors/types.ts`
- `src/connectors/http.ts`
- `src/ingestion.ts`
- `src/code-mode.ts`
- `src/constants.ts`
- `package.json`
- Git 证据：提交 `ceded10`、`f89b05d`、`fd3a702`、`8278c36`、`0fa1430`
