# Development

## Run Against Another Local Repo

Prerequisites:

- Node.js 20 or newer
- pnpm

Set up pnpm's global bin directory once if `pnpm link --global` has not worked
on this machine yet:

```sh
pnpm setup
```

Restart your shell, or source the profile file that `pnpm setup` changed. Then
set up and link this package:

```sh
cd /path/to/openwiki
pnpm install
pnpm run build
pnpm link --global
```

Run a dry test from the repo you want OpenWiki to inspect:

```sh
cd /path/to/target/repo
OPENWIKI_DEV=1 openwiki --dry-run
```

Run the real CLI from the target repo:

```sh
cd /path/to/target/repo
openwiki
openwiki -p "Summarize what you can do"
openwiki --modelId openai/gpt-5.5
openwiki "Please focus on API documentation"
```

The target repo is still the current working directory. The global link only
avoids typing the path to `dist/cli.js`.

If you do not want to configure pnpm globals, use a shell alias instead:

```sh
alias openwiki='node /path/to/openwiki/dist/cli.js'
```

That alias can go in `~/.zshrc` if you want it to persist.

After changing OpenWiki source code, rebuild from this package directory:

```sh
pnpm run build
```

The existing global link will keep using the rebuilt `dist/cli.js`.

Real runs can write:

- `openwiki/`
- `~/.openwiki/.env` for local OpenRouter model/key settings and optional LangSmith credentials

Scheduled update workflow example:

- `examples/openwiki-update.yml`
