# Files

- [Agent Runtime, Models, and Middleware](agent-runtime.md) - How OpenWiki builds and runs its DeepAgents documentation agent — resolving a model provider and model id, instantiating the right LangChain chat model, mounting a sandboxed docs-only filesystem backend, running the OKF, translation, and crash-guard middleware, and parsing the agent graph stream into display events.
- [Architecture Overview](overview.md) - Top-level map of OpenWiki - the CLI entrypoint, the DeepAgents runtime, the code vs personal modes, native vs host-driven generation, and how Claims, OKF finalization, connectors, and the visualizer fit together.
- [Source Map](source-map.md) - Maps the OpenWiki /src directory to its owned subsystems, giving each one a responsibility and its principal entry files, and identifies the largest, most central files that anchor agent execution, configuration, and repository generation.
