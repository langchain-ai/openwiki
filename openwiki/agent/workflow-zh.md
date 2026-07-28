---
type: 技术文档
title: 代理工作流
description: 解释 OpenWiki 文档代理的命令流程、提供商和模型设置、提示规则及更新元数据行为。记录了代理的基于 Git 的工作流、内容快照保障以及维护代理行为的源码实现索引。
tags: [agent, workflow, documentation, providers, update-metadata]
---

# 代理工作流

文档代理在 `src/agent/` 中实现。它接收一个命令（`chat`、`init` 或 `update`），收集仓库上下文，构建提示，运行 DeepAgents 会话，并记录成功的更新元数据——但仅当文档内容实际发生了变化时。

## 主流程

`src/agent/index.ts` 对非 chat 运行遵循以下序列：

1. 将 `~/.openwiki/.env` 加载到 `process.env`。
2. 通过 `resolveConfiguredProvider()` 解析提供商并确保提供商的 API 密钥存在。
3. 从 CLI 输入、`OPENWIKI_MODEL_ID` 或提供商的默认模型解析模型 ID。
4. 从 Git 状态和之前的更新元数据创建运行上下文。
5. 对当前 `openwiki/` 内容进行快照哈希（运行前）。
6. 构建 system prompt 和 user prompt。
7. 创建提供商特定的模型客户端（`ChatAnthropic`、`ChatOpenRouter` 或 `ChatOpenAI`）。
8. 创建以仓库为根的 DeepAgents `LocalShellBackend`，并使用 SQLite checkpointer。
9. 将消息和工具事件流式传回 CLI。`src/agent/index.ts` 中的 `parseStreamEvent()` 将 LangGraph 协议流规范化为 `OpenWikiRunEvent` 对象。`extractContentBlockText()` 过滤掉非文本内容块——`tool`、`reasoning`、`file` 和 `image` 类型——因此来自文件/图像块的原始 base64 载荷不会泄漏到终端输出中。文本块正常通过。
10. 对于 `init` 和 `update`，将运行后的内容快照与运行前快照比较。**仅当内容发生变化时**才写入 `openwiki/.last-update.json`——或者如果上一次运行被中断而本次运行完成，以清除过期状态。如果运行在流中途失败，catch 块写入元数据并设置 `status: "interrupted"`，以便下次更新重试而非跳过为无操作。

Chat 运行完全跳过元数据写入。

## 提供商特定的模型创建

`src/agent/index.ts` 中的 `createModel()` 按提供商分支：

- **gemini**：`new ChatGoogle({ apiKey, model, platformType: "gai" })` — 使用 Gemini API 密钥访问 Google AI Studio。包含 Gemini 3.x thought-signature 往返选项。
- **gemini-enterprise**：调用 `createGeminiEnterpriseModel()`，它通过 `src/agent/vertex-surface.ts` 中的 `resolveVertexSurface()` 按模型族路由。Claude 模型 → `ChatAnthropic`，使用自定义 `AnthropicVertex` 客户端（`@anthropic-ai/vertex-sdk`，ADC 认证，构造函数周围环境变量被中和，因此杂散的 `ANTHROPIC_API_KEY` 不会覆盖 Google OAuth token）。合作/开源权重模型（Llama、Mistral、DeepSeek、Qwen）→ `ChatOpenAI`，通过 Vertex 的 OpenAI 兼容 MaaS 端点，每请求进行 ADC 认证获取。Gemini/Gemma 模型 → `ChatGoogle`，使用 ADC 和 `apiKey:[REDACTED]` 以阻止 `GOOGLE_API_KEY` 回退。认证为统一的 Google ADC；`GOOGLE_CLOUD_PROJECT` 是必需的，`GOOGLE_CLOUD_LOCATION` 是可选的（默认为 `global`）。
- **anthropic**：`new ChatAnthropic(modelId, { apiKey, anthropicApiUrl? })` — 直接使用 `@langchain/anthropic`。当设置了 `ANTHROPIC_BASE_URL` 时，解析的替代 base URL 作为 `anthropicApiUrl` 传递，因此请求可以路由到自托管或代理的 Anthropic 兼容端点而非默认 API。
- **openai-chatgpt**：`new ChatOpenAI({ apiKey:[REDACTED], model, useResponsesApi: true, zdrEnabled: true, streaming: true, configuration: { baseURL: CODEX_RESPONSES_BASE_URL, defaultHeaders, fetch } })` — 使用 ChatGPT OAuth token 而非 API 密钥。token 在模型创建前通过 `src/agent/openai-chatgpt-oauth.ts` 中的 `ensureFreshChatGptTokens()` 刷新。Codex 后端要求 `store: false`（`zdrEnabled`）和流式传输所有请求。如果 token 缺失，运行中止并显示明确消息引导用户登录。
- **openrouter**：`new ChatOpenRouter({ apiKey, baseURL, model, siteName: "OpenWiki" })` — 直接使用选定的 OpenRouter 模型。
- **bedrock**：`new ChatBedrockConverse({ credentials:[REDACTED] accessKeyId, secretAccessKey }, model, region })` — 使用 `@langchain/aws` Bedrock Converse API，带 AWS 凭证和必需的 region。
- **openai**：`new ChatOpenAI({ apiKey, model, useResponsesApi: true })` — 使用 OpenAI 的 Responses API 进行官方 OpenAI 调用。
- **baseten / fireworks / nebius / nvidia / openai-compatible**：`new ChatOpenAI({ apiKey, configuration: { baseURL? }, model })` — OpenAI 兼容客户端，配置时使用提供商的 base URL。`openai-compatible` 提供商没有默认端点；其 base URL 由用户通过 `OPENAI_COMPATIBLE_BASE_URL` 提供（必需，`requiresBaseUrl: true`），这允许 OpenWiki 面向任何 OpenAI 兼容网关（例如前端上游提供商的 LiteLLM 网关）。

Base URL 通过 `src/constants.ts` 中的 `resolveProviderBaseUrl()` 解析，它优先使用提供商的替代 base URL 环境变量（`baseUrlEnvKey`）而非内置默认值，然后回退到 SDK 自身的默认端点。标记为 `requiresBaseUrl` 的提供商在启动时由 `ensureProviderBaseUrl()` 验证。

提供商重试次数通过 `resolveProviderRetryAttempts()` 解析并传递给 LangChain 模型客户端的 `maxRetries` 选项。该值是首次提供商请求后的重试次数；未设置时默认为 3 次重试。

## 提示策略

`src/agent/prompt.ts` 将产品规则直接编码到 system prompt 中。代理被指示：

- 检查当前代码库并在 `openwiki/` 下编写文档，
- 使用文件系统发现工具和 git 历史而非凭空编造事实，
- 保持初始 wiki 简洁且可导航，
- 避免稀薄/空洞页面——将存根合并到更大的页面中而非创建许多小目录，
- 为人类和未来的代理编写仓库文档，
- 将仓库根视为唯一在范围内的项目，
- 避免读取密钥或 `.env` 文件，
- 在 init 和 update 运行中使用 git 历史，
- 尊重临时计划文件和更新元数据要求，
- 确保顶级 `/AGENTS.md` 和/或 `/CLAUDE.md` 引用 OpenWiki 快速入门（插入或刷新标准化段落）。

User prompt 随命令变化：

- `init` 包含当前 Git 摘要并请求全新文档。
- `update` 包含上次更新元数据和 Git 变更摘要。
- `chat` 只转发用户消息。

### 本地大脑开放问题

本地大脑运行使用 `~/.openwiki/wiki/open-questions.md` 作为关于用户 wiki 或核心记忆模型的不确定性的紧凑队列，而不是复制每个源文档中未解决问题的场所。好的开放问题是会损害未来辅助的东西，例如不明确的日常例程、缺失的地点、不确定的偏好、模糊的人/组织关系或源之间的矛盾。

不要仅仅因为 Notion 规范、会议笔记、邮件线程或源页面包含开放的产品/设计问题就添加一个开放问题。将这些问题保留在源页面、`themes.md` 或 `commitments.md` 中，除非它们明确由用户拥有或揭示了用户记忆图中的空白。在同一个主题键下分组类似问题而非创建许多同项目的条目。

该文件应使用三个部分：

- `Active`：未解决的问题，包含 `Owner`、`Seen`、`Evidence` 和可选的 `Notes`。
- `Answered`：之前开放的问题，包含链接到规范答案或源证据的 `Evidence`，以及 `Answered`。
- `Stale`：已放弃的问题，包含 `Why` 和 `Last seen`。

代理应在每次本地 wiki 运行开始时（当文件存在时）读取 `open-questions.md`，使用运行的证据回答已知问题，并在结束时返回该文件以添加新的未解决问题或将已回答的问题移出 `Active`。已回答的条目应链接到答案证据而非复制可能产生偏差的答案摘要。

### 本地大脑主题

本地大脑运行使用 `themes.md` 作为紧凑的趋势索引，而非叙述页面。优先使用包含 `Topic key`、`Theme/Signal`、`First seen`、`Last seen`、`Confidence`、`Sources`、`Evidence count`、`Status` 和 `Evidence` 的 Markdown 表格。如果表格太拥挤，每个主题使用一个简短的字段条目。

每个主题最多应有 1-2 句简短描述。将详细示例、长上下文、特定源的项目列表和推文/feed 簇保留在 `sources/<connector>.md` 中，然后从主题行链接到该证据。观察列表条目应特别简洁。

### 本地大脑承诺和事务

本地大脑运行使用 `commitments.md` 记录工作承诺、跟进、审批、截止日期和计划工作项。条目应在可从证据推断时包含 `Owner`：`me`、`team`、`other:<name>` 或 `unknown`。

使用 `personal-logistics.md` 记录非工作个人事项，如预约、接送、旅行、家务和行政截止日期。个人事务不应混入 `commitments.md`，除非它们也是工作承诺。

## Git 证据和更新元数据

`src/agent/utils.ts` 负责提示所看到的仓库证据：

- 当前工作树状态，
- 当前 HEAD，
- 当 `.last-update.json` 包含 `gitHead` 或 `updatedAt` 时自上次成功更新以来的变更窗口，
- init 运行（或无先前元数据的更新）最近 20 次提交及变更文件，
- 对 HEAD 的 diff 摘要。

在内容发生变化的成功 init/update 运行上，代理写入 JSON 元数据，包含：

- `updatedAt`
- `command`
- `gitHead`
- `model`
- `status` — `"complete"`（默认）或 `"interrupted"`

该元数据稍后用于限定更新运行范围。当运行在流中途失败时，`src/agent/index.ts` 中的 catch 块调用 `persistRunMetadataIfChanged()` 并设置 `status: "interrupted"`，因此已生成的内容仍可被 diff。`getUpdateNoopStatus()` 随后看到中断状态并不会跳过下次更新——防止可能部分的 wiki 被视为最新。没有 `status` 字段的元数据（来自旧版本）被视为 `"complete"`。未改变内容但完成的 重试仍会重写元数据以清除中断状态。

### 内容快照

`createOpenWikiContentSnapshot()` 计算 `openwiki/` 目录树（排除 `.last-update.json`）的 SHA-256 哈希。代理运行时在运行前后各取一次快照。如果它们匹配——意味着模型未做任何文档变更——则元数据文件不更新，除非上一次运行被中断而本次运行完成，在这种情况下重写元数据以清除过期的 `"interrupted"` 状态。这防止了计划的更新循环在 wiki 已是最新时搅动元数据，同时仍能从失败运行中恢复。

## 模型错误

代理运行时仅使用选定的一次提供商和模型进行运行。瞬态请求失败使用 LangChain 模型客户端的重试处理，可通过 `OPENWIKI_PROVIDER_RETRY_ATTEMPTS` 配置。如果选定的提供商/模型仍然失败，OpenWiki 会显示提供商错误并停止，而不是用另一个模型重试。

## 为什么这很重要

代理不仅仅是一个通用的聊天包装器。它被有意约束，以便它可以：

- 编写仓库本地文档而不游离到仓库之外，
- 通过检查点和元数据保持跨运行的连续性，
- 保持更新基于 Git 证据，
- 通过内容快照检查避免元数据搅动，
- 支持交互式和计划的维护用例。

## 更改代理行为时的注意事项

- 保持提示与 CLI 使用的实际文件系统工具和路径约定同步。
- 注意 `.last-update.json` 语义，因为更新运行使用它来决定自上次成功运行以来发生了什么变化。`status` 字段（`"complete"` / `"interrupted"`）控制无操作跳过：`getUpdateNoopStatus()` 在上次运行被中断时不跳过，完成的重试即使没有内容变更也会清除状态。
- 内容快照检查意味着无操作更新不会更新元数据。如果你更改快照逻辑，确保 `.last-update.json` 仍被排除。
- 凭证加载发生在模型解析之前；那里的更改会影响引导和代理启动。
- 添加提供商时，在 `createModel()` 中添加一个分支并确保 `ensureProviderKey()` 检查其 API 密钥环境键。基于 OAuth 的提供商（如 `openai-chatgpt`）跳过 `ensureProviderKey()`，而是在 `createModel()` 被调用前需要一个 token 刷新步骤。没有 API 密钥的提供商（如 `gemini-enterprise`）在 `PROVIDER_CONFIGS` 中声明其所需的环境键（例如 `projectEnvKey`），并由 `getMissingProviderEnvKey()` 门控。
- DeepAgents 后端配置了 `virtualMode: true`，这对于仅文档行为很重要。`src/agent/docs-only-backend.ts` 中的自定义 `OpenWikiLocalShellBackend` 添加了仅文档写入保护，在仅文档模式下将写入限制在 `openwiki/` 目录中。

## 源码索引

- `src/agent/index.ts`
- `src/agent/prompt.ts`
- `src/agent/utils.ts`
- `src/agent/types.ts`
- `src/agent/docs-only-backend.ts`
- `src/agent/openai-chatgpt-oauth.ts`
- `src/constants.ts`
- `src/env.ts`
- Git 证据：提交 `ceded10`、`f89b05d`、`dfa73cc`、`a82759f`、`0fa1430`
