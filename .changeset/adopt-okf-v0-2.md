---
"openwiki": minor
---

Adopt OKF v0.2 output: the bundle-root index now declares `okf_version: "0.2"`, agent prompts instruct the `generated: {by, at}` trust field (actor `openwiki/<version>`) in place of the superseded `timestamp`, and the front-matter validator checks the v0.2 provenance, trust, and lifecycle families (`generated`, `verified`, `sources`, `status`, `stale_after`) while still tolerating the legacy `timestamp` on v0.1 pages.
