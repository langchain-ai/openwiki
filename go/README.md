# OpenWiki Headless CLI (Go)

Headless OpenWiki agent for CI and scripting. Uses OpenRouter as the sole model provider.

## Build

```sh
cd go
just build
```

The binary is written to `go/bin/openwiki`.

## Usage

```sh
# Initialize documentation
openwiki init

# Update documentation (streams progress to stderr)
openwiki update

# Update and print final output (CI-friendly)
openwiki update --print
openwiki --update --print   # legacy flags

# Ask a one-shot question
openwiki print -m "What can you do?"

# Choose a model
openwiki init --model anthropic/claude-sonnet-5
```

## Configuration

Set credentials via environment variables or `~/.openwiki/.env`:

- `OPENROUTER_API_KEY` (required)
- `OPENWIKI_MODEL_ID` (optional, default: `z-ai/glm-5.2`)
- `OPENWIKI_DEBUG=1` (optional verbose stderr)

## Commands

| Command | Description |
|---------|-------------|
| `openwiki init` | Generate initial `openwiki/` documentation |
| `openwiki update` | Refresh existing documentation from repo changes |
| `openwiki print -m "..."` | One-shot Q&A; prints final assistant text to stdout |

Legacy root flags `--init`, `--update`, and `-p/--print` are supported for CI compatibility.

## Architecture

- **Cobra CLI** — `internal/cmd`
- **Config** — `~/.openwiki/.env` loader, OpenRouter-only settings
- **Agent loop** — custom ReAct loop with OpenRouter tool calling
- **Tools** — virtual filesystem (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`) and `execute`
- **Git/metadata** — git evidence, update noop detection, content snapshot, `.last-update.json`

The interactive TypeScript Ink CLI remains available via `npm install -g openwiki`.
