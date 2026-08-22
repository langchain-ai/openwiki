# Files

- [Docs-Only Backend & Access Boundary](backend.md) - The sandboxed filesystem/shell backend that enforces OpenWiki's docs-only, .openwikiignore, and Claims-ownership boundaries, plus the virtual mounts and permissions the agent graph layers on top.
- [Middleware Pipeline](middleware.md) - The ordered LangChain middleware that keeps generated wikis OKF-conformant, translates pages on language switches, and reconciles provenance, links, and mermaid deterministically around each run.
- [Model Providers](model-providers.md) - How OpenWiki resolves a provider and model, validates credentials, and builds the concrete LangChain chat model across thirteen providers including ChatGPT OAuth and Vertex AI.
- [Agent Core & Run Lifecycle](overview.md) - How the OpenWiki documentation agent is assembled and how a single run flows from environment load through streaming to metadata persistence and Claims finalization.
- [Prompts & Review Subagents](prompts.md) - How OpenWiki selects and templates the code and personal prompts, how bundled skills are synced, and the read-only review subagents that critique the plan and verify coverage on repository init.
