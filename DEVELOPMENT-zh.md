# 开发指南

## 对另一个本地仓库运行

前提条件：

- Node.js 20 或更高版本
- pnpm

如果 `pnpm link --global` 在本机上还没有成功运行过，请先设置 pnpm 的全局 bin 目录：

```sh
pnpm setup
```

重启你的 shell，或 source `pnpm setup` 修改的 profile 文件。然后设置并链接此包：

```sh
cd /path/to/openwiki
pnpm install
pnpm run build
pnpm link --global
```

从你希望 OpenWiki 检查的仓库中进行试运行：

```sh
cd /path/to/target/repo
OPENWIKI_DEV=1 openwiki --dry-run
```

从目标仓库运行真正的 CLI：

```sh
cd /path/to/target/repo
openwiki
openwiki -p "Summarize what you can do"
openwiki --modelId openai/gpt-5.5
openwiki "Please focus on API documentation"
```

目标仓库仍然是当前工作目录。全局链接只是省去了输入 `dist/cli.js` 路径的麻烦。

如果你不想配置 pnpm 全局安装，可以使用 shell alias 替代：

```sh
alias openwiki='node /path/to/openwiki/dist/cli.js'
```

如果希望该 alias 持久化，可以将它放入 `~/.zshrc`。

修改 OpenWiki 源代码后，从本包目录重新构建：

```sh
pnpm run build
```

现有的全局链接会继续使用重新构建的 `dist/cli.js`。

实际运行会写入：

- `openwiki/`
- `~/.openwiki/.env`——用于本地 OpenRouter 模型/密钥设置和可选的 LangSmith 凭证

计划的更新工作流示例：

- `examples/openwiki-update.yml`
