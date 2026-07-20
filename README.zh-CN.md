# OpenWiki

[English](./README.md) | [中文说明](./README.zh-CN.md)

OpenWiki 是一个命令行工具，用于为代码仓库或个人知识建立和维护面向 AI Agent 的 Wiki。它可以通过内置连接器或 Git 仓库收集本地知识，并将其整理为可持续更新的本地 Wiki。

![OpenWiki](https://raw.githubusercontent.com/langchain-ai/openwiki/main/static/openwiki.png)

## 安装

```sh
npm install -g openwiki
```

也可以使用 pnpm：

```sh
pnpm add -g openwiki
```

在 Windows 上，建议使用 Node.js 包管理器安装。通过 Bun 安装时，`better-sqlite3` 可能需要本地编译；请先安装 Visual Studio Build Tools，并启用 Desktop development with C++ 工作负载。

## 快速开始

在代码仓库中初始化 OpenWiki。首次运行会引导你选择模型提供商并配置凭据：

```sh
openwiki --init
```

OpenWiki 提供两种运行模式：

- **代码模式**：在当前仓库的 `openwiki/` 目录中生成和维护项目文档。
- **个人模式**：将已配置的信息源整理为个人知识库，默认位置为 `~/.openwiki/wiki`。

以下命令使用代码模式：

```sh
openwiki --init
openwiki --update
```

以下命令使用个人模式：

```sh
openwiki personal --init
openwiki personal --update
```

## 常用命令

在当前仓库启动交互式代码模式：

```sh
openwiki
```

带着初始请求启动：

```sh
openwiki "为这个仓库生成文档"
```

启动交互式个人知识库：

```sh
openwiki personal
```

执行一次请求后退出：

```sh
openwiki -p "总结你可以做什么"
```

显示帮助：

```sh
openwiki --help
```

在交互会话中，可以使用 `/api-key` 更新当前模型提供商的 API 密钥，或使用 `/langsmith-key` 更新或清除 LangSmith 追踪密钥。输入会以掩码显示。

## 自动更新文档

将示例工作流复制到你的 Git 提供商配置中，即可定期创建包含文档更新的 Pull Request 或 Merge Request：

- GitHub Actions：复制 [`openwiki-update.yml`](./examples/openwiki-update.yml) 到 `.github/workflows/openwiki-update.yml`。
- GitLab CI：使用 [`openwiki-update.gitlab-ci.yml`](./examples/openwiki-update.gitlab-ci.yml)。
- Bitbucket Pipelines：使用 [`openwiki-update.bitbucket-pipelines.yml`](./examples/openwiki-update.bitbucket-pipelines.yml)，并在项目设置中创建定时任务。

在 GitHub Actions 中，请使用以下命令更新代码仓库文档：

```sh
openwiki code --update --print
```

CI 中不需要先运行 `--init`。只要工作流提供了模型提供商和模型所需的环境变量，`--update` 会在必要时创建首个 `openwiki/` 文档目录。

## Open Knowledge Format 兼容性

OpenWiki 在代码模式和个人模式下均生成符合 [Google Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) 的知识包：

- 非保留 Markdown 概念文件包含带非空 `type` 的 YAML front matter。
- 标准字段、有效时间戳和生产者定义的扩展字段会在更新和迁移中保留。
- `index.md` 与 `log.md` 是保留文档；根 `index.md` 声明 `okf_version: "0.1"`。
- 概念文档之间使用标准 Markdown 链接表达关系。

## 本地连接器

个人模式可以从多个来源构建知识库，包括本地 Git 仓库、Notion、Gmail、X/Twitter、网页搜索和 Hacker News。同一种连接器可以配置多个实例，例如分别为 AI 研究和篮球新闻创建两个网页搜索源。

可使用以下命令管理连接器：

```sh
openwiki ingest all
openwiki ingest web-search
openwiki auth slack
openwiki auth gmail
openwiki auth x
openwiki auth notion
```

连接器的密钥以环境变量名称引用，并保存到 `~/.openwiki/.env`；配置文件不应包含明文密钥。完整的连接器认证与配置说明请参阅英文 README。

## 模型提供商

OpenWiki 支持 OpenAI、ChatGPT 登录、OpenRouter、Gemini AI Studio、Gemini Enterprise（Vertex AI）、Nebius、Fireworks、Baseten、NVIDIA NIM、OpenAI 兼容端点、AWS Bedrock 和 Anthropic。

首次配置时选择提供商和模型即可。你也可以通过环境变量预先配置：

```sh
OPENWIKI_PROVIDER=openai
OPENAI_API_KEY=your-api-key
OPENWIKI_MODEL_ID=gpt-5.6-terra
```

### OpenAI 兼容端点

对于兼容 OpenAI Chat Completions API 的网关或本地服务，设置基础 URL、密钥和模型 ID：

```sh
OPENWIKI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=your-gateway-key
OPENAI_COMPATIBLE_BASE_URL=http://localhost:20128/v1
OPENWIKI_MODEL_ID=your-routed-model-id
```

### AWS Bedrock

Bedrock 使用 AWS IAM 身份，而不是单一的厂商 API 密钥。未配置静态密钥时，OpenWiki 会交由 AWS SDK 默认凭证链处理，因此支持计算环境附加的 IAM Role、`~/.aws/credentials` 中的配置文件、AWS SSO 与标准 AWS 凭证环境变量。

IAM Role 或 profile 方式至少需要设置提供商、模型和区域。区域变量按以下优先级读取：`BEDROCK_AWS_REGION`、`AWS_REGION`、`AWS_DEFAULT_REGION`。

```sh
OPENWIKI_PROVIDER=bedrock
AWS_REGION=us-east-1
OPENWIKI_MODEL_ID=anthropic.claude-sonnet-5
```

也支持静态密钥方式：

```sh
OPENWIKI_PROVIDER=bedrock
BEDROCK_AWS_ACCESS_KEY_ID=your-access-key-id
BEDROCK_AWS_SECRET_ACCESS_KEY=your-secret-access-key
BEDROCK_AWS_REGION=us-east-1
OPENWIKI_MODEL_ID=anthropic.claude-sonnet-5
```

具体可用的模型 ID 取决于 AWS 账户、区域及已启用的基础模型。IAM 策略需要授予相应的 `bedrock:InvokeModel` 和 `bedrock:InvokeModelWithResponseStream` 权限。

### 重试次数

OpenWiki 使用 LangChain 的重试机制处理临时请求失败。可以设置 `OPENWIKI_PROVIDER_RETRY_ATTEMPTS` 覆盖默认值 3：

```sh
OPENWIKI_PROVIDER_RETRY_ATTEMPTS=3
```

该值必须为正整数。

## 遥测

OpenWiki 默认收集匿名汇总使用数据，用于理解工具的使用情况并改进可靠性。不会收集文件内容、仓库数据或名称、凭据、提示词、模型输出、连接器数据、错误消息、文件路径、URL、模型 ID、IP 地址或个人信息。

如需永久关闭遥测，可将以下任一变量写入环境或 `~/.openwiki/.env`：

```sh
OPENWIKI_TELEMETRY_DISABLED=1
# 或使用跨工具标准变量：
DO_NOT_TRACK=1
```

## 贡献与许可证

欢迎贡献。提交 Pull Request 前，请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。本项目采用 [MIT License](./LICENSE)。

本文档是英文 README 的中文说明版本；功能、完整配置与最新细节以 [English README](./README.md) 为准。
