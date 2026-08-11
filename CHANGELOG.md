# openwiki

## 0.3.2

### Patch Changes

- [#616](https://github.com/langchain-ai/openwiki/pull/616) [`7531d61`](https://github.com/langchain-ai/openwiki/commit/7531d615216e8cbccf464f66cfbbae3668871c84) Thanks [@colifran](https://github.com/colifran)! - fix: pin patched js-yaml and undici via pnpm overrides

- [#513](https://github.com/langchain-ai/openwiki/pull/513) [`adc03d6`](https://github.com/langchain-ai/openwiki/commit/adc03d6f68812bc842c1a020be98738cb1e17568) Thanks [@colifran](https://github.com/colifran)! - chore: reorganize repo code to make into domain specific directories and improve test coverage to prevent regressions

- [#610](https://github.com/langchain-ai/openwiki/pull/610) [`c74ae1e`](https://github.com/langchain-ai/openwiki/commit/c74ae1e3ebc9a01e6ea84420931eea9d833fd1fa) Thanks [@Tomaskobel](https://github.com/Tomaskobel)! - fix: preserve exec bit on dist/cli.js after build

- [#599](https://github.com/langchain-ai/openwiki/pull/599) [`f9b9f0d`](https://github.com/langchain-ai/openwiki/commit/f9b9f0d6f1f1084c93633d943cabb54201263036) Thanks [@sudipawtg](https://github.com/sudipawtg)! - Pass Windows `APPDATA` and `LOCALAPPDATA` into stdio MCP child environments so local MCP servers can resolve their config and cache directories.

- [#605](https://github.com/langchain-ai/openwiki/pull/605) [`bff302c`](https://github.com/langchain-ai/openwiki/commit/bff302cc764688095d2051f968adc4d1013857af) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore: bump mermaid from 11.16.0 to 11.16.1

- [#611](https://github.com/langchain-ai/openwiki/pull/611) [`817b2a0`](https://github.com/langchain-ai/openwiki/commit/817b2a0b8df3ec265e73bac58ae8b462d595139a) Thanks [@colifran](https://github.com/colifran)! - chore: reorganize CLI into domain modules and add test coverage

- [#604](https://github.com/langchain-ai/openwiki/pull/604) [`a0e28a3`](https://github.com/langchain-ai/openwiki/commit/a0e28a30fba1c80bc883711eab48292c5f8c398d) Thanks [@colifran](https://github.com/colifran)! - fix: harden error classification and run accounting

- [#612](https://github.com/langchain-ai/openwiki/pull/612) [`3d51348`](https://github.com/langchain-ai/openwiki/commit/3d51348c4f307e1dfa2f13d6b8803716d52b3ca3) Thanks [@colifran](https://github.com/colifran)! - chore: split credentials.tsx pure logic into credentials/ modules with tests

## 0.3.1

### Patch Changes

- [#585](https://github.com/langchain-ai/openwiki/pull/585) [`1e6b395`](https://github.com/langchain-ai/openwiki/commit/1e6b395b162b52929cf39eaf219f7fb034af023f) Thanks [@colifran](https://github.com/colifran)! - fix: stop the internal link validator from falsely flagging valid links

- [#589](https://github.com/langchain-ai/openwiki/pull/589) [`a86d0ba`](https://github.com/langchain-ai/openwiki/commit/a86d0bad2c457de299cab5659092197a53f7d7f5) Thanks [@colifran](https://github.com/colifran)! - fix: fingerprint innermost cause and chain-walk origin tag

## 0.3.0

### Minor Changes

- [#579](https://github.com/langchain-ai/openwiki/pull/579) [`1e818ae`](https://github.com/langchain-ai/openwiki/commit/1e818ae3e719a07e7d9a3c5f175c82791a7e98c0) Thanks [@bracesproul](https://github.com/bracesproul)! - Improve coding-agent wiki prompts and make OpenWiki guidance optional and just-in-time.

### Patch Changes

- [#555](https://github.com/langchain-ai/openwiki/pull/555) [`ad9c7b5`](https://github.com/langchain-ai/openwiki/commit/ad9c7b5f943c688b9de42b8cca968199c54da16f) Thanks [@GautamSharma99](https://github.com/GautamSharma99)! - fix: report rejected and timed-out telemetry sends accurately

- [#547](https://github.com/langchain-ai/openwiki/pull/547) [`0aa6ddc`](https://github.com/langchain-ai/openwiki/commit/0aa6ddcb57464b1541fe3457c4331418c3fdf28e) Thanks [@GautamSharma99](https://github.com/GautamSharma99)! - fix: preserve agent instructions when managed markers are malformed

- [#560](https://github.com/langchain-ai/openwiki/pull/560) [`5a2e8dc`](https://github.com/langchain-ai/openwiki/commit/5a2e8dc569bbcab48728c65f8e1ffe8980f04dbf) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - refactor: expose openwiki agent graph factory

- [#371](https://github.com/langchain-ai/openwiki/pull/371) [`5f8a8fb`](https://github.com/langchain-ai/openwiki/commit/5f8a8fb5c4943eb0b9474f1a74efb9c0824f6226) Thanks [@DecentralizedJM](https://github.com/DecentralizedJM)! - feat: validate wiki internal links after generation

- [#578](https://github.com/langchain-ai/openwiki/pull/578) [`73d8591`](https://github.com/langchain-ai/openwiki/commit/73d859158f9d6865bdb69692a24ad0cbf3a54d65) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps): bump postcss from 8.5.21 to 8.5.23

- [#564](https://github.com/langchain-ai/openwiki/pull/564) [`03128a6`](https://github.com/langchain-ai/openwiki/commit/03128a6b7efa037c6b597ec9e11c9b3199468240) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps): bump the major group with 3 updates

- [#568](https://github.com/langchain-ai/openwiki/pull/568) [`13e2f97`](https://github.com/langchain-ai/openwiki/commit/13e2f97f2a3a1cbb9f78721604fb5f75445def8f) Thanks [@divya0795](https://github.com/divya0795)! - fix: display array tool-call arguments as a value list instead of `0=…, 1=…`

- [#549](https://github.com/langchain-ai/openwiki/pull/549) [`5323914`](https://github.com/langchain-ai/openwiki/commit/53239142fad3a635aae88ba957bcee358e69e00c) Thanks [@GautamSharma99](https://github.com/GautamSharma99)! - fix: serialize concurrent environment saves and isolate temporary files

- [#577](https://github.com/langchain-ai/openwiki/pull/577) [`c30edbc`](https://github.com/langchain-ai/openwiki/commit/c30edbcc97f6587f2fe18626ba6609732a8d5cc5) Thanks [@colifran](https://github.com/colifran)! - fix: fetch full git history in scheduled update workflows

- [#576](https://github.com/langchain-ai/openwiki/pull/576) [`45d2416`](https://github.com/langchain-ai/openwiki/commit/45d24167583d06c971ba59259a2a7e5e58c452d7) Thanks [@colifran](https://github.com/colifran)! - fix: make the residual agent_error telemetry bucket diagnostic

## 0.2.5

### Patch Changes

- [#514](https://github.com/langchain-ai/openwiki/pull/514) [`b8c510f`](https://github.com/langchain-ai/openwiki/commit/b8c510fce4afab5cc855390f67f833137183d646) Thanks [@colifran](https://github.com/colifran)! - chore: setup changeset tooling for automated releases

- [#530](https://github.com/langchain-ai/openwiki/pull/530) [`1695c3f`](https://github.com/langchain-ai/openwiki/commit/1695c3f841a90543e5c292a871204faf5de0df9c) Thanks [@Monkey-wusky](https://github.com/Monkey-wusky)! - fix: allow comma in model id for gateway/proxy routing identifiers

- [#533](https://github.com/langchain-ai/openwiki/pull/533) [`fdfdfd8`](https://github.com/langchain-ai/openwiki/commit/fdfdfd8825237abe879d019c9211245f0d17ce40) Thanks [@jyje](https://github.com/jyje)! - fix: keep release workflow opt-in on forks

- [#481](https://github.com/langchain-ai/openwiki/pull/481) [`b3b0b43`](https://github.com/langchain-ai/openwiki/commit/b3b0b4320f184abbd686e05c85afdc0623c8e687) Thanks [@HwangJohn](https://github.com/HwangJohn)! - fix: ignore stray oauth callback requests

- [#455](https://github.com/langchain-ai/openwiki/pull/455) [`161b6a4`](https://github.com/langchain-ai/openwiki/commit/161b6a47d64eda29d0eedf9bfff6fc3966a527c2) Thanks [@colifran](https://github.com/colifran)! - feat: implement native wiki visualizer for openwiki

- [#165](https://github.com/langchain-ai/openwiki/pull/165) [`d6e5fbe`](https://github.com/langchain-ai/openwiki/commit/d6e5fbe2b09081fcaddc0419aa541b52bd3e30c0) Thanks [@n33levo](https://github.com/n33levo)! - feat: exclude paths from doc runs via .openwikiignore

- [#504](https://github.com/langchain-ai/openwiki/pull/504) [`63c848c`](https://github.com/langchain-ai/openwiki/commit/63c848cecf506871411852318c391635d0e038d5) Thanks [@Mohith26](https://github.com/Mohith26)! - fix: route summarization history offload outside the documented repo

- [#534](https://github.com/langchain-ai/openwiki/pull/534) [`aa417e1`](https://github.com/langchain-ai/openwiki/commit/aa417e14ddd4d74bf70b705367c31c7d164f9d3c) Thanks [@colifran](https://github.com/colifran)! - chore(deps): bump @langchain/core to ^1.2.4 to pick up the nested-tracer coalescing fix

- [#500](https://github.com/langchain-ai/openwiki/pull/500) [`b469109`](https://github.com/langchain-ai/openwiki/commit/b469109d12ef005e2d86688b200e78d57c236027) Thanks [@colifran](https://github.com/colifran)! - chore: improve health telemetry to better understand and diagnose init and update failures
