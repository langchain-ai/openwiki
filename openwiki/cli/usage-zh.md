---
type: CLI 参考
title: OpenWiki CLI 用法
description: OpenWiki 命令行用法参考，包括交互式和非交互式运行、初始化和更新模式、连接器操作和认证设置。涵盖提供商配置、模型选择、验证以及更改 CLI 行为时需要更新的源文件。
tags: [openwiki, cli, commands, configuration, authentication]
---

# CLI 用法

OpenWiki 以单一 `openwiki` 二进制文件发布，既可以作为交互式终端应用使用，也可以作为一次性文档运行器使用。

## 命令和模式

来自 `src/commands.ts` 和 `README.md`，支持的入口模式有：

- `openwiki` — 打开交互式 chat UI。
- `openwiki "message"` — 立即发送 chat 消息，然后保持开启。
- `openwiki personal --init [message]` — 生成初始本地个人大脑 wiki 文档。
- `openwiki code --init [message]` — 生成初始仓库文档。
- `openwiki --update [message]` — 刷新现有 OpenWiki 文档。
- `openwiki -p, --print` — 运行一次并打印最终助手输出（非交互式）。
- `openwiki --modelId <id>` / `--model-id <id>` — 为运行选择模型 ID。
- `openwiki --help` / `-h` — 打印用法、选项和示例。
- `openwiki --dry-run` — 仅开发选项，避免调用代理。

### 连接器和运维子命令

- `openwiki auth <provider>` — 为连接器提供商（gmail、notion、slack、x）运行 OAuth 登录。
- `openwiki auth configure <provider> [--force]` — 创建引用已保存认证环境变量的本地连接器配置。
- `openwiki auth tools <provider>` — 列出连接器（例如 notion）可用的 MCP 工具。
- `openwiki auth`（不带 provider）— 列出支持的认证提供商及其状态。
- `openwiki ngrok start [url] [--port <port>]` — 为 Slack OAuth 回调启动 ngrok HTTPS 隧道。
- `openwiki cron list` — 显示已保存的连接器计划、launchd 状态和 Mac 唤醒窗口。
- `openwiki cron pause <source|all>` — 卸载 launchd 作业，保留 cron 元数据，协调 `pmset` 唤醒窗口。
- `openwiki cron resume <source|all>` — 重新安装已暂停的 launchd 作业并协调 `pmset` 唤醒窗口。
- `openwiki cron delete <source|all>` — 卸载并移除计划元数据（不删除认证、配置、原始数据或 wiki 内容）。
- `openwiki ingest [target]` — 为已配置的连接器运行特定源的摄取。

解析器拒绝不兼容的组合（如 `--init` 和 `--update` 同时使用），并在使用 `--print` 时要求提供消息或命令。

### init/update 的自动退出

当显式 init（`openwiki personal --init` 或 `openwiki code --init`）或 `--update` 在 TTY 中运行（不带 `--print`）时，CLI 启动运行，流式传输代理输出，并**在成功时自动退出**（`src/cli.tsx` 中的 `shouldAutoExitStartupRun`）。Chat 运行和 `--print` 运行不受影响——chat 保持开启以发送后续消息，`--print` 写入 stdout 并退出。

### 非交互式模式

如果 stdin 不是 TTY（例如 CI），或使用了 `--print`，CLI 要求提供商的凭证已保存在 `~/.openwiki/.env` 中或存在于环境中——提供商 API 密钥，或 gemini-enterprise 提供商的 `GOOGLE_CLOUD_PROJECT`。如果值缺失，它将以明确的错误消息报错，而非交互式提示。

## 交互式行为

`src/cli.tsx` 是基于 Ink 的应用 shell。它处理：

- chat 提交和后续消息，
- `init` / `update` 命令启动（包括从 `/init` 和 `/update` 斜杠命令），
- 会话期间的提供商和模型选择（`/provider`、`/model`），
- 需要时的交互式凭证设置（包括 init/update，不仅仅是 chat），
- 流式代理文本和工具事件，
- 已完成运行的历史和错误显示，
- 帮助、错误和显式 `/exit` 消息的退出处理。

UI 通过 `saveOpenWikiEnv()` 将提供商和模型选择持久化回 `~/.openwiki/.env`。

## 凭证和引导

首次交互式运行可能提示：

- **提供商**（`OPENWIKI_PROVIDER`）— openai、openai-chatgpt、openrouter、anthropic、gemini、gemini-enterprise、bedrock、baseten、fireworks、nebius、nvidia 或 openai-compatible，
- **提供商 API 密钥**（例如 `OPENROUTER_API_KEY`、`OPENAI_API_KEY`、`OPENAI_COMPATIBLE_API_KEY`、`ANTHROPIC_API_KEY`、`BASETEN_API_KEY`、`FIREWORKS_API_KEY`、`GEMINI_API_KEY`、`NEBIUS_API_KEY`）— gemini-enterprise 提供商跳过此项，改为提示 **GCP 项目**（`GOOGLE_CLOUD_PROJECT`，必需）和 **GCP 位置**（`GOOGLE_CLOUD_LOCATION`，可选，默认为 `global`）；bedrock 提供商也跳过，改为提示 AWS access key ID、secret access key 和 region，
- 需要 base URL 的提供商的 **base URL**（openai-compatible 提供商提示 `OPENAI_COMPATIBLE_BASE_URL`），
- 存储为 `OPENWIKI_MODEL_ID` 的 **模型 ID** — 从提供商模型列表中选择或自定义 ID，
- 可选的 `LANGSMITH_API_KEY` 用于追踪。

如果提供了 LangSmith 密钥，引导还会启用 `LANGCHAIN_PROJECT=openwiki` 和 `LANGCHAIN_TRACING_V2=true`。

`src/credentials.tsx` 确定是否需要设置，并使用方向键选择菜单引导用户完成缺失值。详见[凭证和更新](../operations/credentials-and-updates.md)。

## 提供商和模型选择

提供商及其模型选项在 `src/constants.ts` 的 `PROVIDER_CONFIGS` 中定义：

| 提供商           | 环境变量键                                                     | Base URL                                       | 模型                                                                          |
| ----------------- | ------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| openai            | `OPENAI_API_KEY`                                              | （默认，或 `OPENAI_BASE_URL`）                | 5.6 Terra, 5.6 Luna, 5.6 Sol, 5.5, 5.4 mini                                     |
| openai-chatgpt    | `OPENAI_CHATGPT_ACCESS_TOKEN`                                 | （Codex 后端）                                | 同 openai（OAuth 登录，无 API 密钥）                                        |
| openrouter        | `OPENROUTER_API_KEY`                                          | `https://openrouter.ai/api/v1`                 | GLM 5.2, Fusion, Kimi K2.7 Code, Claude Opus/Sonnet, GPT 5.4 mini/5.5           |
| anthropic         | `ANTHROPIC_API_KEY`                                           | （默认，或 `ANTHROPIC_BASE_URL`）             | Haiku, Sonnet, Opus                                                             |
| gemini            | `GEMINI_API_KEY`                                              | （AI Studio）                                    | Gemini 3.6 Flash, 3.5 Flash/Lite, 3.1 Pro, 3 Flash, 3.1 Flash-Lite              |
| gemini-enterprise | 无（Google ADC）— 需要 `GOOGLE_CLOUD_PROJECT`           | 按 `GOOGLE_CLOUD_LOCATION`（默认 `global`） | Vertex AI 上的 Gemini 模型 + Claude Haiku/Sonnet/Opus；粘贴模型 ID 的 MaaS |
| bedrock           | `BEDROCK_AWS_ACCESS_KEY_ID` + `BEDROCK_AWS_SECRET_ACCESS_KEY` | 按 `BEDROCK_AWS_REGION`（必需）            | 账户/区域特定；直接粘贴 Bedrock 模型 ID                        |
| baseten           | `BASETEN_API_KEY`                                             | `https://inference.baseten.co/v1`              | GLM 5.2, Kimi K2.7 Code                                                         |
| fireworks         | `FIREWORKS_API_KEY`                                           | `https://api.fireworks.ai/inference/v1`        | GLM 5.2, Kimi K2.7 Code                                                         |
| nebius            | `NEBIUS_API_KEY`                                              | `https://api.tokenfactory.nebius.com/v1/`      | Kimi K2.6                                                                       |
| nvidia            | `NVIDIA_API_KEY`                                              | `https://integrate.api.nvidia.com/v1`          | Nemotron 3 Super/Ultra/Nano, DeepSeek V4 Pro, GPT-OSS 120B, Kimi K2.6           |
| openai-compatible | `OPENAI_COMPATIBLE_API_KEY`                                   | `OPENAI_COMPATIBLE_BASE_URL`（必需）        | 仅自定义模型 ID                                                            |

默认提供商为 `openai`，默认模型为 `gpt-5.6-terra`。`resolveConfiguredProvider()` 从 `OPENWIKI_PROVIDER` 选取提供商，然后按以下顺序回退到第一个已配置的提供商 API 密钥：OpenAI、OpenAI-compatible、OpenRouter、Anthropic、Baseten、Fireworks、Nebius、NVIDIA、Bedrock，最后是 `DEFAULT_PROVIDER`。

### 提供商重试次数

设置 `OPENWIKI_PROVIDER_RETRY_ATTEMPTS` 以覆盖首次提供商请求后的重试次数。该值必须是正整数：

```bash
OPENWIKI_PROVIDER_RETRY_ATTEMPTS=3
```

如果未设置，OpenWiki 默认为 3 次重试。

### 替代 base URL

设置 `ANTHROPIC_BASE_URL` 将 anthropic 提供商路由到替代的、
Anthropic 兼容的端点（例如自托管或代理网关）
而非默认 API。设置后，它作为 `anthropicApiUrl` 传递给 `ChatAnthropic`；`ANTHROPIC_API_KEY` 仍作为请求
凭证发送。

### OpenAI 兼容提供商

`openai-compatible` 提供商面向任何 OpenAI 兼容的 chat-completions
端点。它没有默认端点，因此 `OPENAI_COMPATIBLE_BASE_URL` 是
**必需的**（交互式设置会提示输入，如果缺失则运行提前中止）。这对于 OpenAI 兼容的 LLM 端点很有用，
例如 LiteLLM 网关暴露的端点，让你通过单个 OpenAI 形式的 API
访问网关前端的任何上游提供商。
因为该提供商没有预设模型
列表，将 `OPENWIKI_MODEL_ID`（或在设置中选择"自定义模型 ID"）设置为网关暴露的
名称。

```bash
OPENWIKI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=[REDACTED]
OPENAI_COMPATIBLE_BASE_URL=https://<gateway>/v1
OPENWIKI_MODEL_ID=<gateway 暴露的模型名称>
```

Base URL 由 `src/constants.ts` 中的 `resolveProviderBaseUrl()` 解析，它
优先使用提供商的 `baseUrlEnvKey` 覆盖而非内置默认值。

### Gemini（AI Studio）提供商

`gemini` 提供商通过 AI Studio
（`platformType: "gai"`）使用 `GEMINI_API_KEY` 运行 Google 的 Gemini 模型。它包含 Gemini 3.x
thought-signature 往返处理。

```bash
OPENWIKI_PROVIDER=gemini
GEMINI_API_KEY=[REDACTED]
```

### Gemini Enterprise（Vertex AI）提供商

`gemini-enterprise` 提供商使用 Google Application Default Credentials（无密钥——
通过 `GOOGLE_APPLICATION_CREDENTIALS` 的服务账户
密钥、`gcloud auth application-default
login` 或工作负载身份）运行 Google Vertex AI Model
Garden 的模型。`GOOGLE_CLOUD_PROJECT` 是必需的；
`GOOGLE_CLOUD_LOCATION` 是可选的，默认为 `global`（由
`src/constants.ts` 中的 `resolveProviderLocation()` 解析）。

模型路由根据模型 ID 自动进行，通过
`src/agent/vertex-surface.ts` 中的 `resolveVertexSurface()`：

- **Claude 模型**（ID 匹配 `anthropic`/`claude`）→ `ChatAnthropic`，使用
  自定义 `AnthropicVertex` 客户端（`@anthropic-ai/vertex-sdk`）。
- **合作/开源权重模型**（Llama、Mistral、DeepSeek、Qwen 等）→
  `ChatOpenAI`，通过 Vertex 的 OpenAI 兼容 MaaS 端点，由自定义 fetch 包装器注入每请求 ADC bearer token。
- **Gemini/Gemma 模型** → `ChatGoogle`，使用 ADC 和 `apiKey:[REDACTED]` 以防止
  杂散的 `GOOGLE_API_KEY` 劫持企业路径。

```bash
OPENWIKI_PROVIDER=gemini-enterprise
GOOGLE_CLOUD_PROJECT=<gcp 项目 id>
GOOGLE_CLOUD_LOCATION=global   # 可选
```

Claude 的模型 ID 可以带 `@` 版本后缀（例如
`claude-haiku-4-5@20251001`），模型 ID 验证器接受。MaaS 模型
ID（例如 `meta/llama-3.3-70b-instruct-maas`）可以直接粘贴。

### AWS Bedrock 提供商

`bedrock` 提供商使用 `ChatBedrockConverse`（`@langchain/aws`）和 AWS
凭证。它需要 access key ID（`BEDROCK_AWS_ACCESS_KEY_ID`）、
secret access key（`BEDROCK_AWS_SECRET_ACCESS_KEY`）和 region
（`BEDROCK_AWS_REGION`）。可用模型 ID 是账户和区域特定的，
因此没有预设模型列表——直接粘贴 Bedrock 模型 ID（例如
`anthropic.claude-sonnet-5-20260101-v1:0`）。

## 帮助文本和验证

帮助内容集中在 `src/commands.ts` 中并由 CLI UI 使用。模型验证有意严格：

- 模型 ID 被修剪，
- 必须匹配允许的字符模式（`/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u`），
- URL 被拒绝。

## 编辑 CLI 时的注意事项

- 首先在 `src/commands.ts` 中更新解析器行为。
- 然后在 `src/cli.tsx` 和 `README.md` 中更新任何用户可见的文本。
- 如果新选项影响运行行为，确保 `src/agent/index.ts` 和 `src/credentials.tsx` 仍接收正确的输入。
- 如果添加提供商，更新 `src/constants.ts` 中的 `PROVIDER_CONFIGS` 和 `SELECTABLE_OPENWIKI_PROVIDERS`、`src/env.ts` 中的 `managedEnvKeys`、以及 `src/agent/index.ts` 中的 `createModel` 分支。基于 OAuth 的提供商（如 `openai-chatgpt`）还需要一个 token 刷新流程和 `createModel` 中读取 `process.env` token 的专用分支。`apiKeyEnvKey` 是可选的——没有它的提供商（如 `gemini-enterprise`）改为声明其需要的环境键（例如 `projectEnvKey`），`getMissingProviderEnvKey()` 根据哪个必需键缺失来门控运行。有配对密钥的提供商（如 `bedrock`）使用 `secretKeyEnvKey`，需要 region 的提供商使用 `regionEnvKey` 和 `requiresRegion: true`。
- 要让提供商接受替代 base URL，在其 `PROVIDER_CONFIGS` 条目上设置 `baseUrlEnvKey`，将该键添加到 `src/env.ts` 中的 `managedEnvKeys`，并通过提供商的 `createModel` 分支中的 `resolveProviderBaseUrl()` 读取。
- 要要求用户提供的 base URL（无默认端点的提供商，如 `openai-compatible`），还需设置 `requiresBaseUrl: true`。`src/agent/index.ts` 中的 `ensureProviderBaseUrl()` 在运行时强制执行，交互式设置为这类提供商添加 base URL 步骤。
- 如果入口点发生变化，重新检查 `package.json` 的 bin 条目和脚本。

## 源码索引

- `src/cli.tsx`
- `src/commands.ts`
- `src/credentials.tsx`
- `src/constants.ts`
- `src/env.ts`
- `src/agent/index.ts`
- `src/agent/openai-chatgpt-oauth.ts`
- `src/auth/oauth.ts`
- `src/auth/providers.ts`
- `src/auth/configure.ts`
- `src/auth/ngrok.ts`
- `README.md`
- `package.json`
- Git 证据：提交 `ceded10`、`f89b05d`、`fd3a702`、`8278c36`、`0fa1430`
