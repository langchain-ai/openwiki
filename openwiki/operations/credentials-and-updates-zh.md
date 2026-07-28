---
type: 运维指南
title: 凭证和更新
description: OpenWiki 本地凭证存储、引导元数据、提供商诊断和更新跟踪的运维参考。涵盖计划工作流和 CI 自动化以安全维护 OpenWiki 内容。
tags: [operations, credentials, updates, scheduling, ci]
---

# 凭证和更新

OpenWiki 有四个对用户和维护者都很重要的运维关注点：

1. `~/.openwiki/.env` 中的本地凭证存储，以及
2. `~/.openwiki/INSTRUCTIONS.md`（personal 模式）或 `<repo>/openwiki/INSTRUCTIONS.md`（code 模式）中持久化的个人 wiki 指令，
3. `~/.openwiki/onboarding.json` 中持久化的引导/计划元数据，
4. `openwiki/.last-update.json` 中持久化的更新元数据。

它还附带了 GitHub Actions 和 GitLab CI 工作流示例用于计划更新。

## 安装说明

在 Windows 上，建议使用 Node.js 包管理器（如
`npm` 或 `pnpm`）安装 OpenWiki。Bun 全局安装路径可能需要回退到编译
`better-sqlite3`，这需要安装 Visual Studio Build Tools 并勾选
使用 C++ 的桌面开发工作负载。Bun 默认不会运行已安装
包的生命周期脚本，因此 OpenWiki 无法在该原生
依赖构建开始前显示安装时警告。

## 本地凭证存储

`src/env.ts` 管理用户 home 目录下的私有环境文件：

- 目录：`~/.openwiki`（模式 `0o700`）
- 文件：`~/.openwiki/.env`（模式 `0o600`）

该文件存储提供商配置和 API 密钥：

- `OPENWIKI_PROVIDER` — 选定的模型提供商
- `OPENWIKI_MODEL_ID` — 默认模型 ID
- `OPENWIKI_PROVIDER_RETRY_ATTEMPTS` — 可选正整数重试次数，用于瞬态提供商请求失败；未设置时默认为 3
- 提供商 API 密钥：`OPENROUTER_API_KEY`、`OPENAI_API_KEY`、`OPENAI_COMPATIBLE_API_KEY`、`ANTHROPIC_API_KEY`、`BASETEN_API_KEY`、`FIREWORKS_API_KEY`、`GEMINI_API_KEY`、`NEBIUS_API_KEY`
- ChatGPT OAuth token（用于 `openai-chatgpt` 提供商）：`OPENAI_CHATGPT_ACCESS_TOKEN`、`OPENAI_CHATGPT_REFRESH_TOKEN`、`OPENAI_CHATGPT_EXPIRES_AT`、`OPENAI_CHATGPT_ACCOUNT_ID`、`OPENAI_CHATGPT_EMAIL`、`OPENAI_CHATGPT_PLAN`
- 连接器 OAuth 凭证：[REDACTED]、`OPENWIKI_GMAIL_REFRESH_TOKEN`、`OPENWIKI_GOOGLE_CLIENT_ID`、`OPENWIKI_GOOGLE_CLIENT_SECRET`、`OPENWIKI_NOTION_MCP_ACCESS_TOKEN`、`OPENWIKI_NOTION_MCP_CLIENT_ID`、`OPENWIKI_NOTION_MCP_REFRESH_TOKEN`、`OPENWIKI_SLACK_USER_TOKEN`、`OPENWIKI_SLACK_CLIENT_ID`、`OPENWIKI_SLACK_CLIENT_SECRET`、`OPENWIKI_X_ACCESS_TOKEN`、`OPENWIKI_X_CLIENT_ID`、`OPENWIKI_X_CLIENT_SECRET`、`OPENWIKI_X_REFRESH_TOKEN`
- Base URL：`ANTHROPIC_BASE_URL`（可选——将 anthropic 提供商路由到默认 API 以外的 Anthropic 兼容端点）、`OPENAI_COMPATIBLE_BASE_URL`（openai-compatible 提供商必需，它没有默认端点）、`OPENAI_BASE_URL`（可选——覆盖 openai 提供商的默认端点）
- AWS Bedrock 凭证：[REDACTED]、`BEDROCK_AWS_SECRET_ACCESS_KEY`、`BEDROCK_AWS_REGION`（bedrock 提供商全部必需）
- 连接器 API 密钥：`TAVILY_API_KEY` 用于 Web Search
- gemini-enterprise 提供商的 Google Cloud 设置：`GOOGLE_CLOUD_PROJECT`（运行 gemini-enterprise 必需）、`GOOGLE_CLOUD_LOCATION`（可选，默认为 `global`）、`GOOGLE_APPLICATION_CREDENTIALS`（可选服务账户密钥文件路径；从不提示——Google Application Default Credentials 处理认证）
- 可选 LangSmith 设置：`LANGSMITH_API_KEY`、`LANGCHAIN_PROJECT`、`LANGCHAIN_TRACING_V2`
- 可选 OAuth 回调设置：`OPENWIKI_OAUTH_CALLBACK_PORT` 控制本地回调端口，`OPENWIKI_HTTPS_OAUTH_REDIRECT_URI` 存储 `openwiki ngrok start` 创建的仅 Slack 的 HTTPS 回调 URL。

加载器将这些值合并到 `process.env` 中，同时优先使用进程级值而非文件值。已弃用的键（`OPENAI_BASE_URL`、`OPENAI_ORG_ID`、`OPENAI_PROJECT`）在加载时跳过，在保存时移除。

包含换行符或回车符的值由 `formatEnvValue()` 序列化为双引号字符串，其中 `\n`、`\r`、`\\` 和 `\"` 被转义，加载时由 `parseEnvValue()` 反转义。回车符转义在 Windows 上很重要，因为多行环境变量值可能包含裸 `\r` 字符，否则在往返序列化期间会被静默剥离。

Slack OAuth 可能需要 HTTPS 重定向 URL，因此 `openwiki ngrok start <url>`
保存 `OPENWIKI_HTTPS_OAUTH_REDIRECT_URI`。其他连接器 OAuth 流程，如
X/Twitter 和 Gmail，忽略该 HTTPS 覆盖并使用本地回环
回调 `http://127.0.0.1:<port>/callback`。

Gmail OAuth 保存只读 access token 和 refresh token。在
`openwiki auth gmail` 之后，Google 连接器可以直接进行 Gmail API
摄取而无需 MCP 传输。默认情况下它查询 `newer_than:1d` 并
将 `gmail-messages.json` 写入 `~/.openwiki/connectors/google/raw/<run-id>/`。

Web Search 通过 LangChain 使用 Tavily。首次运行引导要求
`TAVILY_API_KEY`，存储在 `~/.openwiki/.env` 中，并将已配置的搜索
查询写入 `~/.openwiki/connectors/web-search/config.json`。

Hacker News 使用公开的只读 API，不需要凭证。该
连接器可以获取 top/new/best/show/ask/job feeds 和已配置的搜索
查询。

`src/credentials.tsx` 在需要时提供交互式引导流程：

- 提示选择提供商（方向键选择菜单），
- 提示输入提供商的 API 密钥（gemini-enterprise 提供商跳过，改为提示必需的 Google Cloud 项目 ID 和可选位置；bedrock 提供商跳过，改为提示 AWS access key ID、secret access key 和 region），
- 提示选择模型（从提供商模型列表中方向键选择，或自定义模型 ID），
- 可选提示输入 LangSmith 密钥，
- 以限制性文件权限写入结果，
- 保存时移除已弃用的 OpenAI 相关环境变量。

设置流程在凭证缺失时为**所有**交互式命令（chat、init 和 update）运行——不仅仅是 chat。在非交互式模式（无 TTY 或 `--print`）下，缺失的提供商密钥会产生错误而非提示。

## 首次运行引导配置

模型设置后，首次运行引导让用户从五个 wiki
模板中选择一个：Personal Work OS、AI Research Radar、Git Project Wiki、Social Media
Market Briefing 或 Engineering Memory。用户也可以选择 Custom。模板种子化 wiki 范围提示，用户可以在保存前编辑它。

引导然后遍历本地 Git 仓库、
Notion、Gmail、X/Twitter、Web Search 和 Hacker News 的源连接。非密钥设置
偏好存储在 `~/.openwiki/onboarding.json`：

- 选定的模板 ID/名称，
- 哪些源已连接，
- 可选的每源摄取指导，
- 每源 cron 表达式和通俗英文计划描述，
- 计划安装成功时的 macOS LaunchAgent 路径，
- 可选的 macOS `pmset` 唤醒/睡眠窗口元数据。

用户的全局个人 wiki 范围/意图以 Markdown 存储
在 `~/.openwiki/INSTRUCTIONS.md` 中，以便直接编辑。

在 **code 模式**下，wiki 简报存储在仓库级别
`<repo>/openwiki/INSTRUCTIONS.md` 而非全局文件。
`src/onboarding.ts` 中的 `saveRepositoryWikiInstructions()` 在 code 模式引导期间将简报
写入那里，`isRepositoryCodeOnboardingCompleteSync()`
在决定引导是否完成时检查其是否存在。这
确保每个新仓库即使在全局引导配置已完成时也能获得建议的默认 wiki 简报。代理提示将
`/openwiki/INSTRUCTIONS.md` 视为用户编写的控制元数据——它
读取它以获取范围和优先级，但在例行 wiki
维护期间不会重写它。

OAuth token 和客户端密钥不存储在这些文件中。它们留在
`~/.openwiki/.env` 中。

## 本地计划

源计划通过 `cron-parser` 验证并通过
`cronstrue` 描述。在 macOS 上，OpenWiki 将简单的 cron 计划安装为用户
LaunchAgent，位于 `~/Library/LaunchAgents/com.openwiki.<source>.plist`。plist
从设置工作目录运行 `openwiki --update --print`，日志写入
`~/.openwiki/logs/`。

LaunchAgent plist 永远不嵌入密钥值。无法直接表示为 `StartCalendarInterval` 的复杂 cron 表达式
会以警告形式保存在引导配置中，而非不准确安装。

保存源 cron 后，引导还可以用
`pmset` 配置 Mac 唤醒窗口。OpenWiki 计算当前已保存源
计划的共享窗口：在最早支持的计划前 2 分钟唤醒，然后在最晚支持的计划后 30 分钟睡眠。设置使用 macOS
管理员提示，因为更改 `pmset` 重复计划是系统电源
设置。

`pmset` 是单一机器级别的重复计划，而非每源调度器。
从 OpenWiki 设置它可能会替换现有的重复唤醒/睡眠计划。如果
Mac 关闭、断电、电池耗尽，或 cron 表达式无法
表示为简单的每日/每周唤醒窗口，OpenWiki 会保存源 cron
并记录警告，而非安装不准确的电源计划。

已保存的本地计划可以从 CLI 管理：

- `openwiki cron list` 显示已保存的连接器计划、launchd 状态和
  保存的 Mac 唤醒窗口。
- `openwiki cron pause <source|all>` 卸载匹配的 launchd 作业，保留
  cron 元数据，并协调共享 `pmset` 唤醒窗口。
- `openwiki cron resume <source|all>` 从
  保存的 cron 元数据重新安装已暂停的 launchd 作业并协调共享 `pmset` 唤醒窗口。
- `openwiki cron delete <source|all>` 卸载匹配的 launchd 作业，
  移除 OpenWiki LaunchAgent plist，仅删除计划元数据，
  并协调共享 `pmset` 唤醒窗口。它不删除连接器
  认证、连接器配置、原始数据或 wiki 内容。

当暂停或删除后没有活跃的 OpenWiki 计划时，OpenWiki 取消
保存的重复 `pmset` 计划并标记保存的唤醒窗口为禁用。

## 提供商解析

`src/constants.ts` 中的 `resolveConfiguredProvider()` 确定活跃提供商：

1. 如果 `OPENWIKI_PROVIDER` 已设置且有效，使用它。
2. 否则，按以下顺序使用第一个可用的提供商 API 密钥：OpenAI、OpenAI-compatible、OpenRouter、Anthropic、Baseten、Fireworks、Nebius、NVIDIA，然后是 Bedrock。
3. 否则，回退到 `DEFAULT_PROVIDER`（`openai`）及其默认模型（`gpt-5.6-terra`）。

`src/credentials.tsx` 中的 `needsCredentialSetup()` 检查提供商环境变量是否有效以及提供商所需凭证（其 API 密钥，或 gemini-enterprise 的 `GOOGLE_CLOUD_PROJECT`——通过 `src/constants.ts` 中的 `getMissingProviderEnvKey()`）、模型 ID（除非被覆盖）和 LangSmith 密钥是否都存在。任何缺失值或无效提供商都会触发交互式流程。

## 模型和凭证诊断

环境层还为 CLI UI 生成诊断。这些诊断报告：

- 每个凭证来自哪里（`process.env`、`~/.openwiki/.env`、两者或 `unset`），
- 值是否未设置，
- 表观长度，
- 掩码预览，
- 对可疑格式（如空格、换行符、引号或括号后缀）的警告，
- 无效模型 ID，
- 无效提供商值。

诊断覆盖所有提供商密钥（包括 `OPENAI_CHATGPT_ACCESS_TOKEN` 和相关 ChatGPT OAuth token），加上 `OPENWIKI_PROVIDER`、`OPENWIKI_MODEL_ID`、`OPENWIKI_PROVIDER_RETRY_ATTEMPTS`、base URL（`ANTHROPIC_BASE_URL`、`OPENAI_COMPATIBLE_BASE_URL`、`OPENAI_BASE_URL`）、Google Cloud 设置（`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`、`GOOGLE_APPLICATION_CREDENTIALS`）、AWS Bedrock 设置（`BEDROCK_AWS_ACCESS_KEY_ID`、`BEDROCK_AWS_SECRET_ACCESS_KEY`、`BEDROCK_AWS_REGION`）、连接器凭证和 `LANGSMITH_API_KEY`。这使得启动问题更容易诊断而不会暴露密钥值（非密钥值如提供商、模型 ID、重试次数、base URL 和 Google Cloud 设置会完整显示——服务账户密钥_路径_不是密钥，尽管它指向的文件是）。

## 更新元数据

在 `openwiki/` 内容发生变化的 `init` 或 `update` 运行后，`src/agent/utils.ts` 写入 `openwiki/.last-update.json`，包含：

- `updatedAt`
- `command`
- `gitHead`
- `model`
- `status` — `"complete"`（默认）或 `"interrupted"`

内容变更检查使用 `createOpenWikiContentSnapshot()`，它对 `openwiki/` 目录进行哈希（排除 `.last-update.json`）。如果运行前后的哈希相同，则不写入元数据。这防止了计划更新循环在没有文档变更时更新时间戳。

### 中断的运行

当运行在流中途失败时，`src/agent/index.ts` 中的 catch 块仍会调用 `persistRunMetadataIfChanged()` 并设置 `status: "interrupted"`，以便已生成的内容仍可被未来更新 diff。没有这一点，崩溃的运行将与完成的运行无法区分——下次更新会看到干净的工作树和未更改的 git head 并跳过为无操作，将可能部分的 wiki 视为最新。

`getUpdateNoopStatus()` 在跳过前检查 `lastUpdate.status`：如果是 `"interrupted"`，则不跳过。旧版本写入的元数据（无 `status` 字段）被视为 `"complete"`，因此升级不会强制虚假的重新运行。未改变内容但完成的 重试仍会重写元数据以清除残留的中断状态，因此无操作跳过会恢复而非永远重新运行。

更新运行使用此元数据构建自上次成功 OpenWiki 执行以来的变更摘要——优先使用 `gitHead` 获取精确的提交范围，回退到 `updatedAt` 进行基于时间的范围。

## 计划 CI 工作流

在 `openwiki code --init` 期间，`src/code-mode.ts` 还会在目标仓库中创建 `.github/workflows/openwiki-update.yml`（如果尚不存在）。在 `--update` 和 chat 运行时，现有的工作流文件被原样保留，因此仓库特定的自定义（fork 保护、固定 actions、自定义步骤）永远不会被静默覆盖。AGENTS.md 和 CLAUDE.md 片段在每次 code 模式运行时使用 `<!-- OPENWIKI:START -->` / `<!-- OPENWIKI:END -->` 标记就地刷新。

仓库包含 `examples/openwiki-update.yml` 作为可复制的 GitHub Actions 计划更新工作流。它：

- 按计划运行（每日 UTC 08:00）和手动触发，
- 检出仓库，
- 安装 Node.js 22，
- 全局安装 OpenWiki，
- 运行 `openwiki code --update --print`，
- 从 GitHub secrets 传递 `OPENROUTER_API_KEY`、`OPENWIKI_MODEL_ID` 和 `LANGSMITH_API_KEY`，
- 使用 `peter-evans/create-pull-request` 创建限定在 `openwiki` 目录的 pull request。

该工作流是自动维护的良好参考。仓库还包含一个 `checks.yml` 工作流用于 CI（lint/format 检查）。

仓库还包含 `examples/openwiki-update.gitlab-ci.yml` 作为可复制的 GitLab CI 计划更新作业。它：

- 从计划 pipeline 或手动触发的 web pipeline 运行，
- 在 Node.js 22 容器中全局安装 OpenWiki，
- 运行 `openwiki code --update --print`，
- 当 `openwiki/` 未变化时跳过作业的其余部分，
- 将变更提交到生成的 `openwiki/update-$CI_PIPELINE_ID` 分支，
- 将该分支推回 GitLab 项目，以及
- 通过 GitLab API 创建目标为项目默认分支的 merge request。

GitLab 用户应配置模型提供商密钥的受保护 CI/CD 变量，例如 `OPENROUTER_API_KEY`，以及 `OPENWIKI_GITLAB_TOKEN`。GitLab token 需要在目标项目中推送分支和创建 merge request 的权限。

仓库还包含 `examples/openwiki-update.bitbucket-pipelines.yml` 作为可复制的 Bitbucket Pipelines 计划更新作业。它：

- 在自定义计划或手动触发时运行，
- 在 Node.js 22 容器中全局安装 OpenWiki，
- 运行 `openwiki code --update --print`，
- 将变更提交到生成的 `openwiki/update-$BITBUCKET_BUILD_NUMBER` 分支，
- 将该分支推回 Bitbucket 仓库，以及
- 通过 Bitbucket API 创建目标为默认分支的 pull request。

Bitbucket 用户应配置模型提供商密钥的仓库变量（例如 `OPENROUTER_API_KEY`）和 `OPENWIKI_BITBUCKET_TOKEN`。Bitbucket token 需要在目标仓库中推送分支和创建 pull request 的写入权限。

## 更改运维时的注意事项

- `.env` 文件位于仓库之外，因此对其格式的更改应保守。
- 绝不记录真实密钥值；仅记录配置的存在和用途。
- 如果更新元数据语义发生变化，请同时更新代理运行时和解释更新运行如何限定范围的文档。
- 计划自动化依赖于与本地用户相同的 CLI 入口点，因此工作流变更应针对 `package.json` 和 CLI 帮助文本进行验证。
- 添加提供商时，更新 `src/env.ts` 中的 `managedEnvKeys`，以便环境文件格式正确且诊断覆盖新键。没有 API 密钥的提供商（如 gemini-enterprise）在 `PROVIDER_CONFIGS` 中声明其所需环境键（例如 `projectEnvKey`）并由 `getMissingProviderEnvKey()` 门控。有配对密钥和 region 的提供商（如 bedrock）使用 `secretKeyEnvKey` 和 `regionEnvKey` 加 `requiresRegion: true`。
- 内容快照检查意味着不产生变更的 CI 运行不会更新 `.last-update.json` 或创建仅元数据变更的 PR。
- 中断的运行写入 `status: "interrupted"` 以便下次更新重试。如果元数据语义发生变化，请保持 `getUpdateNoopStatus()` 和 `persistRunMetadataIfChanged()` 同步，以保留中断/完整生命周期。

## 源码索引

- `src/env.ts`
- `src/credentials.tsx`
- `src/constants.ts`
- `src/agent/utils.ts`
- `src/agent/index.ts`
- `src/agent/openai-chatgpt-oauth.ts`
- `src/auth/oauth.ts`
- `src/auth/providers.ts`
- `src/auth/configure.ts`
- `src/auth/tokens.ts`
- `src/onboarding.ts`
- `src/schedules.ts`
- `src/code-mode.ts`
- `examples/openwiki-update.yml`
- `examples/openwiki-update.gitlab-ci.yml`
- `examples/openwiki-update.bitbucket-pipelines.yml`
- `README.md`
- Git 证据：提交 `ceded10`、`f89b05d`、`8278c36`、`0fa1430`
