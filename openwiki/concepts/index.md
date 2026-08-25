# Files

- [Grounded Claims](grounded-claims.md) - How OpenWiki grounds generated wiki pages in versioned repository evidence through the Claims model, including the store, session, and runtime split, evidence resolution and staleness detection, and the durability boundary reached at page completion.
- [Model Providers and Credentials](model-providers.md) - Reference for OpenWiki's supported model providers, their environment keys, base URLs, and authentication methods (API keys, ChatGPT OAuth, Vertex ADC, AWS SDK, and external CLI), and where credentials and OAuth tokens are persisted.
- [Open Knowledge Format Output](okf-output.md) - How OpenWiki produces OKF-compliant pages — validated YAML frontmatter, code-owned generation provenance, synchronized directory indexes, and Mermaid diagrams that are validated and degraded before they reach a renderer.
- [Code vs Personal Modes](two-modes.md) - How OpenWiki chooses between code mode (a repository wiki written to openwiki/) and personal mode (a knowledge brain written to ~/.openwiki/wiki), including mode selection, state directories, and which capabilities apply to each mode.
