---
"openwiki": patch
---

fix: sync bundled skills when they ship read-only (Nix store, immutable containers)

`cp` clones the source's mode bits, so skills bundled read-only made the staged
copy read-only too, which broke the atomic swap with `EACCES` on every run and
leaked a `.<skill>-staging-*` directory each time. The staged tree is now made
owner-writable before the swap, so installs and cleanup succeed and self-heal.
