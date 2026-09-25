# Pi integration notes

OpenWiki's `omp` target supports Oh My Pi's native stdio MCP configuration and Agent Skills:

- Project scope: `.omp/mcp.json` and `.omp/skills/openwiki/`.
- Default user scope: `~/.omp/agent/mcp.json` and `~/.omp/agent/skills/openwiki/`.

Oh My Pi (`omp`) is distinct from upstream Pi (`earendil-works/pi`). This integration does not add an upstream Pi target, generated extension, or other Pi-specific artifact. Upstream Pi support requires a separate extension design.

User-scope installation targets Oh My Pi's default profile. Named profiles (`--profile`) and `PI_CODING_AGENT_DIR` overrides use another agent directory; install with `--project` when that is the intended repository-local configuration.
