---
name: write-connector
description: 添加一个新的内置 OpenWiki 源连接器。当用户要求创建或实现 OpenWiki 连接器时使用。
---

# 编写 OpenWiki 连接器

OpenWiki 连接器是 OSS 仓库中的内置 TypeScript 模块。不要创建插件市场、动态连接器包或运行时加载的不可信连接器。添加正常的源文件和测试。

## 必需结构

- 将连接器添加到 src/connectors/types.ts 和 src/connectors/registry.ts。
- 在 src/connectors/sources/<connector>.ts 下实现连接器。
- 连接器必须暴露一个 ConnectorRuntime，包含 id、displayName、description、backend、requiredEnv、supportsAgenticDiscovery 和 ingest()。
- 摄取将原始 JSON/manifests 写入 ~/.openwiki/connectors/<id>/raw/<run-id>/。
- 状态文件位于 ~/.openwiki/connectors/<id>/state.json。
- 配置文件位于 ~/.openwiki/connectors/<id>/config.json。
- 密钥存储在 ~/.openwiki/.env 中，仅通过环境变量名引用。

## 安全规则

- 绝不读取、打印、记录、返回或硬编码密钥值。
- 不要在连接器配置、原始文件、状态、日志或测试中存储凭证。
- 验证连接器 ID 和原始文件路径，确保读取和写入保持在 ~/.openwiki/connectors/<id>/ 内。
- 使用确定性摄取代码进行带凭证的外部获取。
- 如果包装 MCP，将 MCP 服务器视为只读，仅从连接器配置调用白名单的读取/转储操作。
- 不允许不可信的连接器清单实例化任意命令或任意网络端点，除非经过显式内置代码审查。

## 摄取规则

- Git/本地仓库应写入紧凑清单并让代理检查本地仓库作为真实来源。
- 带时间戳的源应存储每流游标。
- 带对象元数据的源应存储 ID、最后编辑时间戳和内容哈希。
- 带分页的源应存储足够的状态以继续而无需重新获取所有内容。
- 原始转储应保留源 ID、时间戳、URL、作者和足够的出处以供引用。

## 面向用户的完成说明

完成后，告诉用户：

- 哪些连接器文件发生了变化，
- 在 ~/.openwiki/.env 中设置哪些环境变量，
- 创建或编辑什么配置文件，
- 如何运行 openwiki personal --update 来触发摄取，
- 源提供商需要哪些 scopes/permissions。
