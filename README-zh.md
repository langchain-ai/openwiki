# OpenWiki

OpenWiki 是一个 CLI 工具，用于为代码库或用途记忆编写和维护代理 wiki。它专为代理构建，能够通过内置连接器或 git 仓库摄取本地知识源，并将它们合成为本地 wiki。

<div align="center">
  <a href="https://trendshift.io/repositories/70339?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-70339" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/70339/daily" alt="langchain-ai%2Fopenwiki | Trendshift" width="250" height="55"/></a>
</div>

![OpenWiki](https://raw.githubusercontent.com/langchain-ai/openwiki/main/static/openwiki.png)

## 安装

```sh
npm install -g openwiki
```

在 Windows 上，建议使用 Node.js 包管理器（如 `npm` 或 `pnpm`）安装 OpenWiki：

```sh
npm install -g openwiki
# 或
pnpm add -g openwiki
```

`bun install -g openwiki` 可能需要回退到编译 OpenWiki 的 `better-sqlite3`
检查点依赖。在使用该路径之前，请安装 Visual Studio Build Tools 并勾选
使用 C++ 的桌面开发工作负载。Bun 默认不会运行已安装包的生命周期
脚本，因此它无法在该原生依赖构建开始前显示包级别的警告。

## 快速开始

以 code 模式初始化 OpenWiki，配置模型和 API 密钥，然后生成文档：

```sh
openwiki --init
```

OpenWiki 有两种模式：

- **Personal 模式** 从已配置的源（如本地仓库、Gmail、Notion、Web Search、Hacker
  News 和 X/Twitter）在 `~/.openwiki/wiki` 中构建本地个人大脑 wiki。
- **Code 模式** 在 `openwiki/` 中为当前代码库构建仓库文档。

裸 `openwiki --init` 和 `openwiki --update` 在 code 模式下运行。使用
`openwiki personal --init` 或 `openwiki personal --update` 来运行本地
个人大脑 wiki。

然后，为确保文档保持最新，请为你的 Git 提供商添加 CI 工作流，以自动
创建包含文档更新的 PR 或 merge request：

- GitHub Actions：将 [openwiki-update.yml](./examples/openwiki-update.yml) 复制到 `.github/workflows/openwiki-update.yml`。
- GitLab CI：将 [openwiki-update.gitlab-ci.yml](./examples/openwiki-update.gitlab-ci.yml) 复制到 `.gitlab-ci.yml`，或从现有的 GitLab pipeline 中 include 它。
- Bitbucket Pipelines：将 [openwiki-update.bitbucket-pipelines.yml](./examples/openwiki-update.bitbucket-pipelines.yml) 复制到 `bitbucket-pipelines.yml`，然后从 Repository settings > Pipelines > Schedules 中调度 `openwiki-update` 自定义 pipeline。

对于 GitHub Actions 中的仓库文档，使用
`openwiki code --update --print`。你不需要在 CI 中运行 `--init`：
`--update` 会创建初始的 `openwiki/` 文档（如果尚不存在），
只要工作流提供了所需的提供商和模型环境变量。

计划的/CI 运行会发送匿名可靠性遥测数据。请参见 [遥测](#遥测) 了解
收集了什么以及如何关闭（在示例工作流中取消注释 `OPENWIKI_TELEMETRY_DISABLED`）。

## Open Knowledge Format 兼容性

OpenWiki 在 code 和 personal 模式下都会输出 [Google Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) 包。

- 每个非保留 Markdown 概念都有 YAML front matter，其中包含非空
  `type`；所有其他标准字段均为可选。
- 有效的 `timestamp` 值和生产者定义的扩展字段会被接受，并在
  更新和迁移期间保留。
- `index.md` 和 `log.md` 是保留文档而非概念。嵌套
  索引不包含 front matter，而根索引声明
  `okf_version: "0.1"`。
- 概念文档之间的标准 Markdown 链接表达关系。

## 用法

以 code 模式为当前仓库启动交互式 CLI：

```sh
openwiki
```

以初始请求启动 OpenWiki：

```sh
openwiki "Please generate documentation for this repository"
```

转而启动交互式本地个人大脑：

```sh
openwiki personal
```

运行单个命令并退出：

```sh
openwiki -p "Summarize what you can do"
```

初始化 OpenWiki：

```sh
openwiki --init
```

初始化本地个人大脑 wiki：

```sh
openwiki personal --init
```

更新仓库代码文档：

```sh
openwiki --update
```

更新本地个人大脑 wiki：

```sh
openwiki personal --update
```

运行可以先摄取已配置本地连接器的更新：

```sh
openwiki personal --update "Refresh the wiki from configured connectors"
```

显示帮助：

```sh
openwiki --help
```

在聊天中，使用 `/api-key` 更新当前提供商 API 密钥，
`/langsmith-key` 更新或清除 LangSmith 追踪凭证。两个命令
都使用掩码输入提示。

认证一个连接器提供商：

```sh
openwiki auth slack
openwiki auth gmail
openwiki auth x
openwiki auth notion
```

为 Slack OAuth 启动 ngrok 隧道：

```sh
openwiki ngrok start
```

这会以一个随机的 HTTPS 转发 URL 启动 ngrok。OpenWiki 读取 ngrok
的本地检查 API，追加 `/callback`，并自动保存
`OPENWIKI_HTTPS_OAUTH_REDIRECT_URI`。在 Slack 中注册打印的 callback
URL。如果你有固定的 ngrok 域名，运行
`openwiki ngrok start https://<your-ngrok-domain>`。X/Twitter 和 Gmail 认证
忽略该 HTTPS 覆盖，继续使用本地回环 callback，
`http://127.0.0.1:53682/callback`。

裸 `openwiki` 以 code 模式为当前仓库运行。当不存在 wiki 时，它会在 `openwiki/` 中创建初始仓库文档。使用 `openwiki personal` 来运行 `~/.openwiki/wiki/` 中的本地通用 wiki。默认情况下，CLI 在每次运行后保持开启，以便你发送后续消息。使用 `-p` 或 `--print` 进行一次性非交互式运行，打印最终助手输出。

裸 `openwiki --init` 和 `openwiki --update` 默认为 code 模式，操作仓库文档。使用 `personal` 位置模式或 `--mode personal` 来初始化或更新本地个人大脑 wiki。

在每次 `code` 运行时，`openwiki` 会同时在仓库根目录维护一个 `AGENTS.md` 和一个 `CLAUDE.md`，添加提示指令，指导你的编码代理在搜索上下文时参考 wiki。如果文件不存在则会创建。如果文件已存在，OpenWiki 只重写其自己的 `<!-- OPENWIKI:START -->…<!-- OPENWIKI:END -->` 块，保留其余内容不变（首次添加时追加该块）。计划的 GitHub Actions 工作流将这些文件连同工作流本身一起包含在文档 pull request 中。

仓库特定的 wiki 指令单独存储在
`openwiki/INSTRUCTIONS.md` 中。此文件是仓库 wiki 的共享、用户编写的简报：OpenWiki 读取它以获取范围和优先级，但它不是生成的文档，在正常的 init、update 或 chat
运行期间不会被重写，除非你明确要求更改简报。

在首次交互式运行时，OpenWiki 会让你配置推理提供商、API 密钥和 LLM。你还可以设置 LangSmith API 密钥，将你的 OpenWiki 运行追踪到名为 "openwiki" 的 LangSmith 追踪项目（可选）。

这些配置选项和密钥将保存到你本地机器的 `~/.openwiki/.env` 中。

## 本地连接器

OpenWiki 的首次运行引导提供本地 Git 仓库、Notion、Gmail、X/Twitter、Web Search 和 Hacker News 的连接器设置。在摄取运行期间，确定性连接器工具将原始数据和清单写入 `~/.openwiki/connectors/<connector>/raw/`，然后特定源的代理运行从这些本地文件合成 `~/.openwiki/wiki/` 下的本地 wiki。

你可以多次配置同一个连接器。例如，添加一个 Web
Search 源用于 AI 研究，另一个用于 NBA 新闻；OpenWiki 将它们存储为
独立的源实例，如 `web-search-1` 和 `web-search-2`。使用
`openwiki ingest all` 运行所有实例，使用
`openwiki ingest web-search` 运行一个连接器的所有实例，或使用
`openwiki ingest web-search-2` 运行一个实例。

- `git-repo` 读取已配置的本地仓库路径并写入紧凑清单。
- `x` 使用 X API，通过 OAuth 用户上下文凭证获取首页时间线、用户帖子、提及、书签和列表帖子。
- `notion` 面向托管的 Notion MCP 服务器，因此用户应通过 Notion OAuth 认证，而不是将 Notion token 粘贴到 OpenWiki 中。
- `google` 使用 Gmail API，通过 OAuth 用户凭证直接获取最近邮件，后续有空间添加 Drive、Calendar 和其他 Google 提供商。
- `web-search` 通过 LangChain 使用 Tavily，需要 `TAVILY_API_KEY`。
- `hackernews` 使用公开的 Hacker News feed 和搜索 API，无需凭证。

连接器密钥通过环境变量名引用并存储在 `~/.openwiki/.env` 中；连接器配置文件不应包含原始密钥值。

`openwiki auth <provider>` 运行本地浏览器 OAuth 流程，将返回的 token 保存到 `~/.openwiki/.env`，在可能时创建连接器配置，并为 MCP 支持的提供商发现 MCP 工具。Slack 和 Gmail 要求该文件中已设置应用客户端凭证；Notion 使用动态客户端注册来托管 MCP；X 使用带 PKCE 的 OAuth 2.0。在 `openwiki auth gmail` 之后，Google 连接器可以直接摄取 Gmail，无需 MCP 传输设置。

`openwiki auth configure <provider>` 和 `openwiki auth tools <provider>` 是高级/重试命令，用于重新生成连接器配置或检查实时 MCP 工具。

首次运行引导还允许用户选择 wiki 模板，自定义其范围，
并将每源摄取笔记和源计划保存到
`~/.openwiki/onboarding.json`。全局个人 wiki 指令保存
在 `~/.openwiki/INSTRUCTIONS.md` 中。在 macOS 上，源计划作为
用户 LaunchAgent 安装在 `~/Library/LaunchAgents/` 下，日志写入
`~/.openwiki/logs/`。

请参阅 OpenWiki 运维文档以了解凭证存储和提供商设置
说明。

## 自定义

OpenWiki 开箱即用支持 OpenAI（使用 API 密钥或 ChatGPT 登录）、OpenRouter、Gemini（AI Studio）、Gemini Enterprise（Vertex AI）、Nebius Token Factory、Fireworks、Baseten、NVIDIA NIM、OpenAI 兼容提供商、AWS Bedrock、Anthropic 和 GitHub Copilot。引导默认为 OpenAI 和 `gpt-5.6-terra`，每个推理提供商还包含预定义模型选项以及自定义模型 ID 支持。

### GitHub Copilot

GitHub Copilot 提供商通过 OpenAI 兼容的 Copilot API（`https://api.githubcopilot.com`）路由推理，因此团队可以复用现有的 Copilot 订阅，而无需配置单独的推理 API 密钥。

1. 在 `openwiki --init` 期间选择 `GitHub Copilot` 作为提供商。如果你已有活跃的 [GitHub CLI](https://cli.github.com) 会话，OpenWiki 会自动检测并提供复用——无需手动输入 token。否则，在凭证提示处按 <kbd>Tab</kbd> 即可原地运行 `gh auth login` 并登录。
2. 选择一个模型（例如 `gpt-5.5`）。

OpenWiki 将 GitHub CLI token 留在 GitHub CLI 自己的凭证存储中；它不会将该 token 复制到 `~/.openwiki/.env` 中。对于 CI 或其他没有 GitHub CLI 会话的无头环境，将 `COPILOT_API_KEY` 显式设置为 GitHub **OAuth token**。个人访问令牌（classic 或 fine-grained）会被 Copilot API 拒绝用于第三方集成，因此无法工作，尽管 GitHub Copilot CLI 本身接受它们。

生成的本地提供商配置可以不带 token：

```env
OPENWIKI_PROVIDER="copilot"
OPENWIKI_MODEL_ID="gpt-5.5"
```

在 CI（如计划的 GitHub Actions 工作流）中，设置 `COPILOT_API_KEY` 仓库密钥并在工作流环境中导出 `OPENWIKI_PROVIDER=copilot`。

### 替代 base URL

要将 Anthropic 提供商路由到替代的、Anthropic 兼容的端点
（例如自托管或代理网关）而非默认 API，请设置
`ANTHROPIC_BASE_URL` 和 `ANTHROPIC_API_KEY`：

```bash
OPENWIKI_PROVIDER=anthropic
ANTHROPIC_API_KEY=[REDACTED]
ANTHROPIC_BASE_URL=https://your-gateway.example.com/anthropic
```

`openai` 提供商同样支持通过 `OPENAI_BASE_URL` 设置替代的、OpenAI 兼容的
端点（例如自托管或代理网关），与 `OPENAI_API_KEY` 一起设置。Baseten、Fireworks 和 NVIDIA NIM 可以分别通过 `BASETEN_BASE_URL`、
`FIREWORKS_BASE_URL` 和 `NVIDIA_BASE_URL` 路由到替代的 OpenAI 兼容
网关。这对于暴露 Responses API 的 OpenAI 兼容网关很有用，因为
`openai` 提供商通过 Responses API（`/v1/responses`）路由工具调用，而
非 chat completions：

```bash
OPENWIKI_PROVIDER=openai
OPENAI_API_KEY=[REDACTED]
OPENAI_BASE_URL=https://your-gateway.example.com/v1
OPENWIKI_MODEL_ID=your-model-name
```

同样，要将 GitHub Copilot 提供商路由到替代端点
（例如 GitHub Enterprise Cloud 数据驻留主机或代理
网关）而非默认的 `https://api.githubcopilot.com`，请设置
`COPILOT_BASE_URL` 和 `COPILOT_API_KEY`：

```bash
OPENWIKI_PROVIDER=copilot
COPILOT_API_KEY=[REDACTED]
COPILOT_BASE_URL=https://your-tenant.ghe.com/api/copilot
```

### OpenAI 兼容端点

`openai-compatible` 提供商通过必需的 base URL 面向任何 OpenAI 兼容的
chat-completions 端点。这可用于 OpenAI 兼容的 LLM 端点，
例如 LiteLLM 网关用作网关时——让你通过单个
OpenAI 形式的 API 访问网关前端的任何上游提供商。将模型 ID 设置为网关暴露的名称：

```bash
OPENWIKI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=[REDACTED]
OPENAI_COMPATIBLE_BASE_URL=https://your-gateway.example.com/v1
OPENWIKI_MODEL_ID=your-gateway-model-name
```

暴露 OpenAI 兼容 chat completions 的本地 LLM 服务器使用相同的
提供商。模型 ID 必须匹配该本地服务器上可用的模型：

```bash
# Ollama，在 `ollama serve` 和 `ollama pull llama3.2` 之后
OPENWIKI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=[REDACTED]
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
OPENWIKI_MODEL_ID=llama3.2
openwiki --init
```

```bash
# LM Studio，从 Developer 标签页启动本地服务器之后
OPENWIKI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=[REDACTED]
OPENAI_COMPATIBLE_BASE_URL=http://localhost:1234/v1
OPENWIKI_MODEL_ID=your-loaded-model-id
openwiki --init
```

对于 9Router 等本地网关，使用网关显示的 OpenAI 兼容端点 URL、
API 密钥和模型 ID：

```bash
OPENWIKI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=[REDACTED]
OPENAI_COMPATIBLE_BASE_URL=http://localhost:20128/v1
OPENWIKI_MODEL_ID=your-routed-model-id
openwiki --init
```

某些本地服务器忽略 API 密钥值，但 OpenWiki 仍然需要
`OPENAI_COMPATIBLE_API_KEY`，因为 OpenAI 兼容客户端期望一个密钥。

### AWS Bedrock

`bedrock` 提供商使用 IAM 凭证调用 AWS Bedrock 上托管的基础模型，
而非单一供应商 API 密钥。现有安装可以
继续提供 AWS access key ID、secret access key 和 region：

```bash
OPENWIKI_PROVIDER=bedrock
BEDROCK_AWS_ACCESS_KEY_ID=your-access-key-id
BEDROCK_AWS_SECRET_ACCESS_KEY=[REDACTED]
BEDROCK_AWS_REGION=us-east-1
OPENWIKI_MODEL_ID=anthropic.claude-sonnet-5
```

当未设置显式 Bedrock 凭证时，OpenWiki 使用 AWS SDK
默认凭证提供商链，包括 OIDC/web identity、IAM roles、
AWS profiles 和 ECS/EC2 凭证。region 从
`BEDROCK_AWS_REGION`、`AWS_REGION` 或 `AWS_DEFAULT_REGION` 解析。

哪些模型 ID 可用取决于你的 AWS 账户和 region（你在
Bedrock 控制台中启用了哪些基础模型），因此没有
预设模型列表——直接粘贴 Bedrock 模型 ID，如上所示。

某些较新的模型只接受通过跨区域
推理 profile 而非裸模型 ID 的按需调用——如果你看到 `ValidationException:
Invocation of model ID ... with on-demand throughput isn't supported`，请将
模型 ID 加上 profile 的 region 代码前缀，例如
`us.anthropic.claude-sonnet-5`。你的 IAM 策略还需要
在该情况下允许 `bedrock:InvokeModel`/`InvokeModelWithResponseStream` 作用于
`foundation-model` 和 `inference-profile` 两种资源类型。

### OpenAI（ChatGPT 登录）

`openai-chatgpt` 提供商使用你的 ChatGPT 订阅调用 OpenAI 的 Codex 后端，
而非按量计费的 API 密钥。模型使用量从你的 ChatGPT
Plus/Pro/Team 计划的包含 Codex 使用量中扣除，而非按 token 的 API 计费。它
提供与 `openai` 提供商相同的模型列表。

无需粘贴 API 密钥，运行设置向导并完成浏览器
登录：

```bash
OPENWIKI_PROVIDER=openai-chatgpt openwiki code --init
# 或
OPENWIKI_PROVIDER=openai-chatgpt openwiki personal --init
```

向导在浏览器中打开 `https://auth.openai.com`（并
为无头/SSH 使用打印 URL，你可以在另一台机器上打开它——或将重定向 URL 粘贴回终端以在没有回调的情况下完成）。在你使用 ChatGPT
账户登录后，OpenWiki 捕获 OAuth 回调，显示
已登录的邮箱和计划，然后像其他提供商一样继续
模型和 LangSmith 选择。它将生成的 access token、refresh
token、过期时间、账户 ID、邮箱和计划存储在 `~/.openwiki/.env`
（`OPENAI_CHATGPT_ACCESS_TOKEN`、`OPENAI_CHATGPT_REFRESH_TOKEN`、
`OPENAI_CHATGPT_EXPIRES_AT`、`OPENAI_CHATGPT_ACCOUNT_ID`、`OPENAI_CHATGPT_EMAIL`、
`OPENAI_CHATGPT_PLAN`）。这些由系统管理——access token 在过期时自动刷新，
因此你通常无需手动编辑它们。请像对待密码一样对待
refresh token。

### Gemini（AI Studio）

`gemini` 提供商通过 AI Studio API 使用单个 API
密钥运行 Google 的 Gemini 模型：

```bash
OPENWIKI_PROVIDER=gemini
GEMINI_API_KEY=[REDACTED]
```

### Gemini Enterprise（Vertex AI）

`gemini-enterprise` 提供商运行来自 Gemini Enterprise Model
Garden（前身为 Vertex AI）的模型——Google 自己的 Gemini/Gemma 模型、Anthropic 的
Claude 以及合作/开源权重模型（Llama、Mistral、DeepSeek、Qwen……）。它
自动将每个模型 ID 路由到正确的 API 表面，因此一个凭证
即可访问所有模型。它不使用 API 密钥——认证通过 Google
Application Default Credentials (ADC) 完成，因此任何标准机制都可以：

- 通过 `GOOGLE_APPLICATION_CREDENTIALS` 的服务账户密钥文件，
- 通过 `gcloud auth application-default login` 获取的用户凭证，或
- 在 Google Cloud（GKE、Cloud Run、GCE）或 CI 中运行时的工作负载身份。

```bash
OPENWIKI_PROVIDER=gemini-enterprise
GOOGLE_CLOUD_PROJECT=your-gcp-project
GOOGLE_CLOUD_LOCATION=global   # 可选，默认为 global
```

将 `OPENWIKI_MODEL_ID` 设置为任何 Model Garden 模型。Gemini 和 Claude 作为
预设选项提供；合作/开源权重模型通过粘贴其模型 ID
（例如 `publishers/meta/models/llama-3.3-70b-instruct-maas`）到达。

使用的凭证需要在项目中具有 Vertex AI 访问权限（`roles/aiplatform.user`），并且你想要的模型必须在 Model Garden 中启用。
`global` 端点提供 Gemini 和 Claude 并提供最佳可用性；
区域端点（例如 `europe-west1` 或 `us-east5`）可通过
`GOOGLE_CLOUD_LOCATION` 设置以满足数据驻留要求。合作/开源权重
(MaaS) 模型是特定区域的，因此使用
它们时请显式设置 `GOOGLE_CLOUD_LOCATION`。

注意，`GOOGLE_CLOUD_PROJECT`（以及 `GOOGLE_APPLICATION_CREDENTIALS`，如果你
选择将其存储在那里）会持久化到 `~/.openwiki/.env` 并在
启动时加载到 OpenWiki 进程环境中——当未设置时，shell 中已
存在的值始终优先。

对于 CI，在更新作业运行之前进行认证——例如使用
[`google-github-actions/auth`](https://github.com/google-github-actions/auth)
（GitHub Actions 中的工作负载身份联合）——并在作业
环境中设置 `OPENWIKI_PROVIDER=gemini-enterprise` 和 `GOOGLE_CLOUD_PROJECT`。

Base URL（和所有凭证）可以设置在你的环境中或存储在 `~/.openwiki/.env` 中。

### OpenRouter 提供商锁定

当 OpenRouter 通过多个上游提供商提供模型时，设置
`OPENWIKI_OPENROUTER_PROVIDER_ONLY` 以将路由限制为单个提供商或
逗号分隔的提供商白名单：

```bash
OPENWIKI_PROVIDER=openrouter
OPENROUTER_API_KEY=[REDACTED]
OPENWIKI_OPENROUTER_PROVIDER_ONLY=Novita
```

### 提供商重试次数

OpenWiki 使用 LangChain 内置的重试处理来应对瞬态提供商错误。
要覆盖首次提供商请求后的重试次数，设置 `OPENWIKI_PROVIDER_RETRY_ATTEMPTS`：

```bash
OPENWIKI_PROVIDER_RETRY_ATTEMPTS=3
```

该值必须是正整数。如果未设置，OpenWiki 默认为 3 次重试。

### 图表

OpenWiki 在生成的 wiki 中嵌入 **Mermaid** 图表，只要图表比文字描述更清晰：
运行时和请求流的时序图、数据模型的 ER 图、
生命周期的状态图以及控制流的流程图。图表基于检查的源代码，
在能增加信号的地方添加而非每页都加，并在 `--update` 运行时保持同步。这是
默认行为；无需配置。

**验证和修复。** 每次运行后，OpenWiki 验证每个 `mermaid`
代码块。验证失败的图表会被原地转换为普通 `text`
代码块，前面加一条简短注释说明原因，因此它会降级为可读
文本而非损坏的块。下一次 `--update` 运行会找到该注释，
根据记录的错误修复图表，并恢复 `mermaid` 代码块，
因此质量会在 successive 运行中恢复。

**验证精度是可选的。** 默认情况下，OpenWiki 运行轻量级、
零依赖的检查来捕获常见的语法错误。它是
尽力而为的：它未识别的错误在
GitHub 上仍可能渲染为错误，直到后续运行捕获它。要与
GitHub 渲染完全匹配的权威验证（捕获每个不可渲染的图表），请在你运行 OpenWiki 的地方
（例如在你重新生成 wiki 的计划的 GitHub
Actions 工作流中）安装 Mermaid 解析器：

```bash
npm install mermaid jsdom
```

当解析器存在时，OpenWiki 使用它，不会有损坏的图表；当它
不存在时，回退到尽力检查。图表生成和
降级修复循环在两种方式下工作方式相同，因此解析器只改变
图表检查的彻底程度，而非是否生成图表。

如果你想看到添加的推理提供商或模型，请提交 PR！

## 遥测

OpenWiki 收集匿名的、聚合的使用数据，以便我们了解工具的使用情况并加以改进。遥测默认开启，且很容易关闭。

**收集了什么**，在单个 `openwiki_run` 事件上，以存储在
`~/.openwiki/install-id` 中的随机安装 ID 为键：

- 每次运行：命令（init / update）和结果（成功 / 失败 /
  无操作），加上失败时的粗略错误类别（绝非错误消息）。
  交互式 chat、`auth` 和 `ingest` 不被记录。
- 设置时（仅在 init 时）：哪种大脑模式（code / personal）、模型
  提供商以及你配置了哪些连接器（仅连接器名称，绝非
  其内容）。

**绝不收集什么：**文件内容、仓库数据或名称、
凭证、提示、模型输出、连接器载荷、错误消息、文件
路径、URL、模型 ID、运行时长、你的 IP 地址或任何个人
信息。Geoip 丰富已禁用，你的 IP 永远不会被存储。事件
按你的随机安装 ID 分组，以便我们衡量重复使用，但该
ID 不包含任何个人数据。

**计划的/CI 运行**作为匿名可靠性数据收集（标记以便
与人工运行区分），使用共享 CI 标识符而非
每台机器的安装 ID，且绝不计为独立安装。要在
CI 中禁用，在工作流环境中设置 `OPENWIKI_TELEMETRY_DISABLED=1`。

要查看运行将发送什么，请在任何运行中添加 `--telemetry-file=<path>`。

### 退出遥测

设置任一环境变量：

```sh
export OPENWIKI_TELEMETRY_DISABLED=1
# 或跨工具标准：
export DO_NOT_TRACK=1
```

要永久禁用，将 `OPENWIKI_TELEMETRY_DISABLED=1` 添加到 `~/.openwiki/.env`。
在 CI 中，在工作流环境中设置它（配置文件在
临时 runner 上不会持久化）。

### 查看发送的确切内容

在任意运行中添加 `--telemetry-file=<path>`，将确切的载荷写入
本地 JSON 文件。

## 贡献

欢迎贡献！请在提交 PR 之前阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。我们有意将 PR 严格控制为每个 PR 一个变更，打包不相关变更的 PR 可能会被关闭并要求拆分。
