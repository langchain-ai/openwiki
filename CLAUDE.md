# argus-wiki

Light-touch fork of [langchain-ai/openwiki](https://github.com/langchain-ai/openwiki), retargeted at the CONTEXT/CORTEX Obsidian vaults instead of a fresh `~/.openwiki` tree.

## Remotes

- `origin` → `deanjstone/argus-wiki` (this fork)
- `upstream` → `langchain-ai/openwiki` (pull periodically: `git fetch upstream && git merge upstream/main`)

## Local divergence from upstream

- `src/constants.ts` / `src/openwiki-home.ts` — `OPEN_WIKI_DIR` and `openWikiHomeDir` are env-overridable (`OPENWIKI_OUTPUT_DIR`, `OPENWIKI_HOME`), defaulting to upstream's original paths when unset. Kept small to stay low-conflict against future upstream merges.

## Not yet done

- Wire `OPENWIKI_HOME`/`OPENWIKI_OUTPUT_DIR` at CONTEXT/CORTEX and validate a real run.
- Structural-vs-routine-write split in the scheduled update → PR workflow (`examples/openwiki-update.yml`, `src/code-mode.ts`) — upstream treats all doc changes as PR-worthy; this fork needs an additive rule so only structural changes go through review.
- Disable telemetry by default (`OPENWIKI_TELEMETRY_DISABLED=1`) given vault content is personal.

---

## OpenWiki (upstream, self-generated)

This repository has documentation located in the /openwiki directory.

Start here:

- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
