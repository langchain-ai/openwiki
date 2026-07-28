---
type: 快速入门指南
title: OpenWiki 快速入门
description: OpenWiki TypeScript CLI 的快速入门参考，包括文档生成工作流、支持的模型提供商和主要源文件。使用它来导航仓库的架构、命令、代理运行时、运维和连接器。
tags: [openwiki, quickstart, cli, documentation]
---

# OpenWiki 快速入门

OpenWiki 是一个 TypeScript CLI，使用代理驱动的工作流为仓库编写和维护文档。该包暴露了一个单一的 `openwiki` 二进制文件，将本地凭证存储在 `~/.openwiki/.env` 中，并将成功更新元数据记录在 `openwiki/.last-update.json` 中。

## 本仓库的功能

- 启动交互式基于 Ink 的终端应用与 OpenWiki 代理聊天。
- 通过 `--init`、`--update` 和 `--print` 支持一次性文档运行。
- 支持多种模型提供商——OpenAI（默认，API 密钥或 ChatGPT OAuth 登录）、OpenRouter、Anthropic、Gemini（AI Studio）、Gemini Enterprise（Vertex AI，通过 Google ADC 无密钥）、AWS Bedrock、Nebius Token Factory、Baseten、Fireworks、NVIDIA NIM 和任何 OpenAI 兼容网关——每个都有自己的凭证和模型列表（Gemini Enterprise 使用 Google ADC 而非 API 密钥；Bedrock 使用 AWS access/secret keys 和 region）。
- 使用以目标仓库为根的 DeepAgents 本地 shell 后端和虚拟文件系统路径。
- 在目标仓库的 `openwiki/` 目录下创建或刷新文档。
- 在交互式终端中成功完成 `--init` 或 `--update` 运行后自动退出，因此 CLI 既可作为一次性工具也可作为交互式工具使用。
- 可选通过 GitHub Actions、GitLab CI 或 Bitbucket Pipelines 计划自动更新。

## 从这里开始

- [架构概览](./architecture/overview.md) — 运行时结构、主要模块和执行流程。
- [CLI 用法](./cli/usage.md) — 命令、选项、模型/提供商选择和凭证引导。
- [代理工作流](./agent/workflow.md) — 文档运行如何组装和持久化。
- [凭证和更新](./operations/credentials-and-updates.md) — 本地环境存储、元数据和计划更新。
- [连接器](./integrations/connectors.md) — 内置连接器架构、七个连接器和摄取编排。

## 关键源文件

- `README.md` — 面向用户的安装和用法摘要。
- `package.json` — bin 入口点、脚本和依赖。
- `src/cli.tsx` — Ink UI、命令执行、自动退出和运行生命周期。
- `src/commands.ts` — CLI 解析和帮助内容。
- `src/agent/index.ts` — 代理运行时、提供商特定模型创建（包括 ChatGPT OAuth）、回退和元数据写入。
- `src/agent/prompt.ts` — 提示组装、文档运行指令和 AGENTS.md/CLAUDE.md 插入规则。
- `src/agent/utils.ts` — git 证据收集、内容快照和 `.last-update.json` 处理。
- `src/agent/types.ts` — 共享代理类型（`OpenWikiCommand`、`RunContext`、`UpdateMetadata`、运行选项/事件）。
- `src/agent/docs-only-backend.ts` — `OpenWikiLocalShellBackend`，扩展 DeepAgents `LocalShellBackend`，增加仅文档写入保护和输出模式感知。
- `src/agent/openai-chatgpt-oauth.ts` — ChatGPT OAuth 流程、token 持久化和刷新逻辑，用于 `openai-chatgpt` 提供商。
- `src/auth/oauth.ts` — 连接器提供商的通用 OAuth runner（Gmail、Notion、Slack、X）。
- `src/auth/providers.ts` — 连接器 OAuth 提供商配置（scopes、token URLs、环境键映射）。
- `src/auth/configure.ts` — `openwiki auth configure <provider>` 流程，用于创建本地连接器配置。
- `src/auth/ngrok.ts` — 通过 ngrok 的 Slack HTTPS 回调隧道。
- `src/auth/tokens.ts` — 连接器 OAuth 的 token 刷新和验证助手。
- `src/connectors/` — 连接器注册表、MCP 客户端/运行时、特定源摄取（git-repo、gmail、hackernews、slack、web-search、x）和工具定义。
- `src/ingestion.ts` — 编排跨已配置连接器的源摄取运行。
- `src/code-mode.ts` — `openwiki code` 设置：仅在缺失时创建 GitHub Actions 工作流（保留更新时的自定义）并刷新 AGENTS.md/CLAUDE.md 片段。
- `src/env.ts` — `~/.openwiki/.env` 持久化和凭证诊断。
- `src/credentials.tsx` — 提供商选择、API 密钥和模型选择的交互式引导流程。
- `src/constants.ts` — 提供商配置、模型选项、环境键和验证助手。
- `examples/openwiki-update.yml` — GitHub Actions 计划自动化示例。
- `examples/openwiki-update.gitlab-ci.yml` — GitLab CI 计划自动化示例。
- `examples/openwiki-update.bitbucket-pipelines.yml` — Bitbucket Pipelines 计划自动化示例。

## 文档索引

- [架构](./architecture/overview.md)
- [CLI](./cli/usage.md)
- [代理](./agent/workflow.md)
- [运维](./operations/credentials-and-updates.md)
- [连接器](./integrations/connectors.md)

## 给未来代理的注意事项

- 仓库有意聚焦：主要产品表面是 CLI 加文档生成代理。
- 将本仓库中的 `openwiki/` 视为未来 OpenWiki 运行生成的文档输出，而非应用源码。
- 更改行为时，验证 CLI 解析器和代理提示/运行时，因为用户可见语义分布在 `src/commands.ts`、`src/cli.tsx` 和 `src/agent/*` 中。
- 提供商支持集中在 `src/constants.ts` 中。添加或更改提供商意味着更新 `PROVIDER_CONFIGS`、`OpenWikiProvider` 类型、`SELECTABLE_OPENWIKI_PROVIDERS` 列表和 `src/agent/index.ts` 中的模型创建分支。基于 OAuth 的提供商如果使用浏览器登录流程还需要在 `src/auth/` 中添加条目。没有 API 密钥的提供商（如 `gemini-enterprise`）在 `PROVIDER_CONFIGS` 中声明其所需环境键（例如 `projectEnvKey`）并由 `getMissingProviderEnvKey()` 门控。

## 源码索引

- `README.md`
- `package.json`
- `src/cli.tsx`
- `src/commands.ts`
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
- `src/connectors/mcp-client.ts`
- `src/connectors/mcp-runtime.ts`
- `src/connectors/io.ts`
- `src/connectors/sources/git-repo.ts`
- `src/connectors/sources/gmail.ts`
- `src/connectors/sources/hackernews.ts`
- `src/connectors/sources/mcp.ts`
- `src/connectors/sources/slack.ts`
- `src/connectors/sources/web-search.ts`
- `src/connectors/sources/x.ts`
- `src/ingestion.ts`
- `src/code-mode.ts`
- `src/env.ts`
- `src/credentials.tsx`
- `src/constants.ts`
- `examples/openwiki-update.yml`
- `examples/openwiki-update.gitlab-ci.yml`
- `examples/openwiki-update.bitbucket-pipelines.yml`
- Git 证据：提交 `ceded10`、`f89b05d`、`a82759f`、`dfa73cc`、`fd3a702`、`8278c36`、`0fa1430`
