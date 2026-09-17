---
"openwiki": patch
---

fix: flag root-absolute internal wiki links instead of silently accepting them

`validateWikiInternalLinks` resolved a root-absolute href (e.g.
`/openwiki/architecture/overview.md`) against the whole repository in
`repository` mode, so it always "existed" and passed validation. No real
consumer resolves it that way: a coding agent reading the page relative to
its own directory, GitHub's Markdown renderer (a leading `/` is relative to
the `github.com` domain, not the repository), and local Markdown viewers all
fail on it. The repository's own checked-in `openwiki/` tree had 53 such
links across 9 files, undetected because the dogfood regression test that
was supposed to catch this had an unrelated path bug that made it scan zero
files. Both are fixed here: root-absolute links are now flagged (stamped, per
the existing broken-link mechanism) in `repository` mode, left unflagged in
`local-wiki` mode (where the backend root is already the wiki root), and the
53 pre-existing links plus the dogfood test's path bug are fixed in the same
change.
