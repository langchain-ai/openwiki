---
"openwiki": minor
---

feat: recursive documentation for monorepos (#162)

Document each subproject of a monorepo in its own nested `openwiki/` sub-wiki,
with the repository-root wiki linking down to them via a generated
`openwiki/workspaces.md`. Enable per run with `openwiki code --update --recursive`
or automatically when an `openwiki/workspaces.json` manifest is present;
`--recursive` with no manifest auto-detects common workspace layouts (pnpm/npm/
yarn, Cargo, Go, uv, Gradle, Maven, .NET solutions, Bazel) and writes one. Each
subproject is evaluated independently and skipped when its own subtree is
unchanged, with no cross-subproject dependency cascade.
