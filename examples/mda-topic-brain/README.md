# OpenWiki topic brain on Managed Deep Agents

This example deploys a topic-focused research brain on [Managed Deep Agents](https://docs.langchain.com/langsmith/python/managed-deep-agents-overview). It searches the web, answers with cited evidence, learns durable topic knowledge across conversations, and can be invoked from Slack. Optional read-only MCP connectors can add internal context from Slack, Notion, or another source.

Managed Deep Agents is currently a public beta on LangSmith Cloud in the US region.

## Customize the topic

Replace `REPLACE_WITH_YOUR_TOPIC` in [`instructions.md`](./instructions.md) with a narrow topic such as a product, research area, market, or project. Refine the source and memory guidance for that topic before deploying.

The example uses OpenAI's hosted web search with `openai:gpt-5.5`. To use another provider, update both `model` and the provider-specific search tool in [`agent.py`](./agent.py), following the [MDA quickstart](https://docs.langchain.com/langsmith/python/managed-deep-agents-quickstart).

## Run locally

Copy the example into its own working directory, then create your local environment file:

```bash
cp .env.example .env
```

Set `LANGSMITH_API_KEY` and `OPENAI_API_KEY` in `.env`. Never commit `.env`; `mda deploy` forwards eligible values as deployment secrets without adding the file to the build archive.

Install the pinned dependency and open the agent in LangSmith Studio:

```bash
uv sync
uv run mda dev .
```

Ask a question that requires current information and confirm the trace includes a web search call and linked sources.

## Add internal context

[`connectors/mcp.py.example`](./connectors/mcp.py.example) shows Slack and Notion placeholders. To enable connectors:

1. Use operator-controlled, HTTPS MCP endpoints that expose only read-only search and fetch operations.
2. Ensure the connector credentials expose only data that every deployment caller is authorized to access.
3. Replace the example URLs and raw tool names with those from your MCP servers.
4. Add the required tokens to `.env` and grant the narrowest scopes possible.
5. Rename the file to `connectors/mcp.py`.
6. Run `uv run mda build .` before deploying.

MDA prefixes MCP tools with the server name. Keep `include_tools` allowlists so a connector cannot unexpectedly add write operations. Do not point the example at arbitrary or private-network URLs, and never hard-code credentials.

The managed Slack channel in [`channels/slack.py`](./channels/slack.py) is the interface through which people invoke the brain. It does not give the agent access to Slack history; add a read-only Slack MCP connector separately when that context is needed.

## Shared knowledge

[`memory.py`](./memory.py) enables deployment-shared durable memory. The agent keeps compact, frequently useful knowledge in `/memories/agent/AGENTS.md` and detailed research notes in other files under `/memories/agent/`.

Every deployment caller can read and influence this memory. Use this example only when the topic knowledge and connector access are appropriate for all authorized callers. Do not persist connector-derived content unless every caller may read it, and do not store raw internal documents, personal or customer-private data, credentials, or tokens. If callers need different source permissions, use identity-aware MCP authorization and caller-scoped memory when available, or deploy separate brains. Remove `memory.py` if callers must not influence one another.

## Deploy

Build the project without deploying:

```bash
uv run mda build .
```

Deploy it to LangSmith:

```bash
uv run mda deploy . --deployment-type prod
```

MDA authenticates direct API callers with the LangSmith API-key identity in [`identity.py`](./identity.py), syncs instructions and skills to Context Hub, provisions the Slack channel, and deploys the agent. On the first Slack-enabled deploy, follow the CLI authorization link to select and authorize your workspace.

The command prints the LangSmith deployment URL. Ask the hosted brain the same current-information question and inspect its LangSmith trace to verify web search and citations.

For production use, review [MDA identity](https://docs.langchain.com/langsmith/python/managed-deep-agents-identity), [memory](https://docs.langchain.com/langsmith/python/managed-deep-agents-memory), [MCP connectors](https://docs.langchain.com/langsmith/python/managed-deep-agents-mcp-connectors), and [deployment](https://docs.langchain.com/langsmith/python/managed-deep-agents-deploy).
