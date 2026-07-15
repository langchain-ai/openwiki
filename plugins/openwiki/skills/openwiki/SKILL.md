---
name: openwiki
description: Generate, update, and answer questions from repository OpenWiki documentation using the active Codex or Claude Code agent instead of the OpenWiki CLI. Use when asked to initialize or refresh an openwiki/ directory, maintain agent-oriented repository docs, or query existing OpenWiki docs without configuring provider API keys.
---

# OpenWiki

Run the OpenWiki workflow with the current coding agent's own model and tools. Do not call the `openwiki` CLI, do not run `npm install -g openwiki`, and do not ask for OpenWiki provider API keys. This skill is the API-key-free path for Codex and Claude Code users.

## Mode selection

- Use `init` when the user asks to initialize, create, or regenerate OpenWiki docs, or when `openwiki/quickstart.md` is missing or clearly not useful.
- Use `update` when the user asks to update or refresh existing OpenWiki docs from recent repository changes.
- Use `chat` when the user asks a question about the repository or the existing OpenWiki docs. In chat mode, answer directly and do not edit files unless the user explicitly asks.
- If the request is ambiguous and `openwiki/quickstart.md` exists, prefer `chat` for questions and `update` for maintenance verbs such as "refresh", "sync", or "bring current".

Claude Code users commonly invoke this as `/openwiki:openwiki init`, `/openwiki:openwiki update`, or `/openwiki:openwiki <question>`. Codex users commonly invoke it through the OpenWiki skill/plugin with the same natural-language mode words.

## Run setup

1. Treat the current working directory as the only target repository.
2. Never read secret values, private keys, tokens, `.env` files, or live credential files. Placeholder examples such as `.env.example` are acceptable only when they do not contain real secrets.
3. Prefer `rg --files` plus targeted reads. Exclude `.git`, dependency folders, build output, cache folders, and existing generated wiki output from broad discovery.
4. If the bundled helper script is reachable, run it from the target repository before init or update:

   ```bash
   python <plugin-root>/skills/openwiki/scripts/openwiki_support.py context --mode init --repo .
   python <plugin-root>/skills/openwiki/scripts/openwiki_support.py context --mode update --repo .
   ```

   In Claude Code plugins, `<plugin-root>` is usually available as `${CLAUDE_PLUGIN_ROOT}`. If the helper path is not available, reproduce the same evidence manually with `git status --short`, `git rev-parse HEAD`, recent `git log --name-status --oneline`, and `git diff --name-status HEAD`.

5. Record the before snapshot for init/update. With the helper, use `snapshot --repo .`. Without it, remember whether `openwiki/` content changed and write metadata only when it did.

## Discovery discipline

- Inspect repository tree, package/config files, README-style files, entrypoints, routing files, schema/data files, tests/evals, operational scripts, and representative files for each major domain.
- Use git history to explain why important code exists. During init, inspect recent commits and selected high-signal files. During update, inspect changes since `openwiki/.last-update.json` when present.
- Do not exhaustively read every file. Use targeted search and short reads for large files.
- Treat existing README files, docs trees, root documentation files, runbooks, and existing `SKILL.md` files as primary source material.
- If existing docs conflict with source code or git history, prefer current source evidence and call out likely stale docs only when it matters.

For large or unfamiliar repositories, use 1-2 read-only subagents when available. Give each subagent a narrow area such as architecture, data/storage, UI/API surface, integrations, tests, or workflows. Subagents must only inspect and summarize; the main agent owns all writes.

## Documentation structure

- Write all persistent documentation under `openwiki/`.
- Do not modify source code outside `openwiki/`. The only allowed exceptions are top-level `AGENTS.md` and `CLAUDE.md`, and only when the user explicitly asks to add or refresh the OpenWiki reference section described below.
- `openwiki/quickstart.md` is required and must be the entrypoint.
- The quickstart must include a high-level repository overview and links to every major section.
- Keep the initial wiki focused: quickstart plus the smallest useful set of section pages. For small repositories, prefer quickstart plus at most 1-2 supporting pages.
- Create a section directory only when it represents a real documentation area and is likely to contain substantive pages.
- Avoid thin pages. Merge stubs into `quickstart.md` or a broader section page.
- Include source-file references inline where they help readers verify or continue exploration.
- Explain what the area does, why it exists, where to start, what to watch out for, and which tests/checks matter when changing it.
- Organize docs for humans and future coding agents, not as a raw file inventory.

## Planning and writes

For init and update:

1. Do discovery first.
2. Create a temporary `openwiki/_plan.md` listing intended wiki pages, source evidence for each page, and remaining questions.
3. Write or edit the final documentation.
4. Delete `openwiki/_plan.md` before finishing.
5. Do not create or update top-level agent instruction files unless the user explicitly asks for that behavior:
   - Only consider top-level `AGENTS.md` and `CLAUDE.md`.
   - If the user opts in and either exists, add or update the standard OpenWiki section there.
   - If the user opts in and both exist, ensure both contain the same section.
   - If the user opts in and neither exists, create top-level `AGENTS.md` containing only the standard section.
   - Preserve surrounding instructions and do not make formatting-only edits if an existing section is semantically correct.

Use this exact OpenWiki section content when a section is missing or stale:

```markdown
## OpenWiki

This repository has documentation located in the /openwiki directory.

Start here:

- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.
```

The helper reports the action it would take without writing by default:

```bash
python <plugin-root>/skills/openwiki/scripts/openwiki_support.py agent-reference --repo .
```

Only apply those changes when the user explicitly asks to update agent instruction files:

```bash
python <plugin-root>/skills/openwiki/scripts/openwiki_support.py agent-reference --repo . --apply
```

## Init behavior

- Assume `openwiki/` does not yet contain useful documentation.
- Build a repository inventory from source, existing docs, config, tests, workflows, and git evidence.
- Create `openwiki/quickstart.md` first, then linked section pages.
- Use at most 8 documentation pages on the first run unless the repository is clearly too large for that.
- Do not try to document every source file.
- Before finishing, review the `openwiki/` tree and remove or merge low-value pages.

## Update behavior

- Inspect existing `openwiki/` docs before editing.
- Read `openwiki/.last-update.json` if it exists.
- Build a docs impact plan from recent source changes: source change -> docs affected -> edit needed -> why.
- Be surgical. Preserve accurate structure and wording.
- Only edit pages whose current content is inaccurate, incomplete, or misleading because of recent changes.
- Do not make formatting-only edits, reorder source lists, or refresh generic "things to watch" sections unless materially wrong.
- Avoid touching `quickstart.md` unless top-level product behavior, setup, or navigation changed.
- Updates may be a no-op. If docs are already current, do not edit files.

## Metadata

For successful init/update runs, write `openwiki/.last-update.json` only if `openwiki/` content changed. The metadata must contain:

```json
{
  "updatedAt": "ISO-8601 timestamp",
  "command": "init",
  "gitHead": "current git HEAD when available",
  "model": "codex-native or claude-code-native or active model name"
}
```

With the helper, finish with:

```bash
python <plugin-root>/skills/openwiki/scripts/openwiki_support.py write-metadata --mode init --repo . --before-snapshot <snapshot> --model agent-native
python <plugin-root>/skills/openwiki/scripts/openwiki_support.py write-metadata --mode update --repo . --before-snapshot <snapshot> --model agent-native
```

If the before and after snapshots match, do not write metadata.

## Final response

For init/update, summarize which docs changed, whether agent instruction files were skipped or updated, whether `.last-update.json` was written, and any caveats. For chat, answer the question and cite the OpenWiki/source paths used.
