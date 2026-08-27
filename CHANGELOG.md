# openwiki

## 0.4.3

### Patch Changes

- [#740](https://github.com/langchain-ai/openwiki/pull/740) [`ec95f45`](https://github.com/langchain-ai/openwiki/commit/ec95f453f60e59ef64bd78a63775ddfd2ceea864) Thanks [@colifran](https://github.com/colifran)! - fix: finalize repository generation once when source changes during a run

## 0.4.2

### Patch Changes

- [#737](https://github.com/langchain-ai/openwiki/pull/737) [`d9e958b`](https://github.com/langchain-ai/openwiki/commit/d9e958bfcf798b1dcc9d0e6240c186b127d045ee) Thanks [@colifran](https://github.com/colifran)! - fix: allow init and update runs to snapshot pages that do not exist yet

## 0.4.1

### Patch Changes

- [#724](https://github.com/langchain-ai/openwiki/pull/724) [`57948ad`](https://github.com/langchain-ai/openwiki/commit/57948ad646f5d97cd1512362421bc629365d902a) Thanks [@akyourowngames](https://github.com/akyourowngames)! - fix: keep hint/legend overlay inside the graph panel and make background clicks no longer clear the reader

- [#730](https://github.com/langchain-ai/openwiki/pull/730) [`9f95289`](https://github.com/langchain-ai/openwiki/commit/9f95289d7c301c98c908422c24a94877fd9efa41) Thanks [@colifran](https://github.com/colifran)! - fix: stabilize generated wiki formatting and claims hashes

- [#728](https://github.com/langchain-ai/openwiki/pull/728) [`d219653`](https://github.com/langchain-ai/openwiki/commit/d219653dd9d38d5645725da142527319224c392c) Thanks [@colifran](https://github.com/colifran)! - fix: prevent invalid optional OKF metadata from aborting wiki generation by repairing or removing it deterministically

- [#732](https://github.com/langchain-ai/openwiki/pull/732) [`ca4e21b`](https://github.com/langchain-ai/openwiki/commit/ca4e21bdf57e962d6c45d5e170cf8742991ab9f4) Thanks [@colifran](https://github.com/colifran)! - fix: skip failed page workers without aborting updates

## 0.4.0

### Minor Changes

- [#581](https://github.com/langchain-ai/openwiki/pull/581) [`fab0a3f`](https://github.com/langchain-ai/openwiki/commit/fab0a3f607a8e193f32672f9f837505c0fc7b6bc) Thanks [@JHSeo-git](https://github.com/JHSeo-git)! - feat: adopt okf v0.2 with code-owned generated provenance

- [#638](https://github.com/langchain-ai/openwiki/pull/638) [`c1ca21b`](https://github.com/langchain-ai/openwiki/commit/c1ca21be797987ff0ce5c6164e34368d1892f839) Thanks [@colifran](https://github.com/colifran)! - feat: add grounded claims for self-correcting code wikis

- [#713](https://github.com/langchain-ai/openwiki/pull/713) [`4882ba3`](https://github.com/langchain-ai/openwiki/commit/4882ba33d89b7fe7499a908606cc818c193adeec) Thanks [@colifran](https://github.com/colifran)! - feat: replace repository generation with a resumable page-job lifecycle

### Patch Changes

- [#685](https://github.com/langchain-ai/openwiki/pull/685) [`392de6f`](https://github.com/langchain-ai/openwiki/commit/392de6fab7ae9820cfdcda7f7e4e255bffe2039c) Thanks [@colifran](https://github.com/colifran)! - feat: add openwiki integrations for coding agents

- [#711](https://github.com/langchain-ai/openwiki/pull/711) [`1c70d0f`](https://github.com/langchain-ai/openwiki/commit/1c70d0f2ba001422964e0397632ef610762472a0) Thanks [@kido5217](https://github.com/kido5217)! - feat: add opencode coding-agent integration target

- [#675](https://github.com/langchain-ai/openwiki/pull/675) [`6ffa7b6`](https://github.com/langchain-ai/openwiki/commit/6ffa7b6debaed25422398c73ccc4d21ad1438795) Thanks [@green3sf](https://github.com/green3sf)! - fix: omit unsupported prompt cache retention from GPT-5.6 ChatGPT requests

- [#674](https://github.com/langchain-ai/openwiki/pull/674) [`da87fa0`](https://github.com/langchain-ai/openwiki/commit/da87fa072ca9b6a1dc9a57f14d7a42afd7993327) Thanks [@BenjiKo14](https://github.com/BenjiKo14)! - feat: add a resizable, collapsible graph panel to the visualizer

- [#682](https://github.com/langchain-ai/openwiki/pull/682) [`04511de`](https://github.com/langchain-ai/openwiki/commit/04511defa728f37cfae81abbdbddbbe3ca632f72) Thanks [@colifran](https://github.com/colifran)! - chore: improve init and update terminal ux

- [#459](https://github.com/langchain-ai/openwiki/pull/459) [`21746ce`](https://github.com/langchain-ai/openwiki/commit/21746ce996f3a69898883da58b122770f7dbd668) Thanks [@geonwoo-jeong](https://github.com/geonwoo-jeong)! - feat: configure model output and bedrock stream limits

- [#548](https://github.com/langchain-ai/openwiki/pull/548) [`31dddea`](https://github.com/langchain-ai/openwiki/commit/31dddea4b6d5f3ebdec639d21ca48bcd2a1744e3) Thanks [@GautamSharma99](https://github.com/GautamSharma99)! - fix: run clean updates when the requested output language changes

- [#274](https://github.com/langchain-ai/openwiki/pull/274) [`98ccf03`](https://github.com/langchain-ai/openwiki/commit/98ccf03eba2a0d8eef93a4a2e2b4e00cbf57a5db) Thanks [@akyourowngames](https://github.com/akyourowngames)! - feat: support OPENWIKI_CONFIG_DIR env var and display configurable paths

- [#634](https://github.com/langchain-ai/openwiki/pull/634) [`a943efb`](https://github.com/langchain-ai/openwiki/commit/a943efba15ab81d92ce532cd1228e37ff7b66a75) Thanks [@jyje](https://github.com/jyje)! - feat: add configurable reasoning effort via OPENWIKI_REASONING_EFFORT for supported OpenAI GPT-5.6 and NVIDIA NIM models

- [#692](https://github.com/langchain-ai/openwiki/pull/692) [`ecec08c`](https://github.com/langchain-ai/openwiki/commit/ecec08c35c3673d55dfb638437f569ca3e1e2fb1) Thanks [@colifran](https://github.com/colifran)! - feat: project claims evidence into okf v0.2 sources front matter and stamp durable machine verification after complete claims reconciliation

- [#715](https://github.com/langchain-ai/openwiki/pull/715) [`dee5272`](https://github.com/langchain-ai/openwiki/commit/dee527240630b980efb8bfae68e04e7508595ea5) Thanks [@colifran](https://github.com/colifran)! - chore: implement better claims reconciliation guidance

- [#660](https://github.com/langchain-ai/openwiki/pull/660) [`bbae2dd`](https://github.com/langchain-ai/openwiki/commit/bbae2dda52de60b23339d3234ee9f8ae57b71c61) Thanks [@JayDataEngineer](https://github.com/JayDataEngineer)! - fix: stream updates instead of messages for openai-compatible providers

- [#656](https://github.com/langchain-ai/openwiki/pull/656) [`f37c70d`](https://github.com/langchain-ai/openwiki/commit/f37c70dbd1949a1b42e06f4218396d373d10baf1) Thanks [@Amzp](https://github.com/Amzp)! - feat: add OPENWIKI_OPENAI_COMPATIBLE_STREAMING=true to force the streaming transport for openai-compatible gateways that return empty content for non-streaming requests

- [#678](https://github.com/langchain-ai/openwiki/pull/678) [`ea80ddc`](https://github.com/langchain-ai/openwiki/commit/ea80ddc3e010ed66202bab159fc95ebb7cb6daee) Thanks [@timaxorum](https://github.com/timaxorum)! - chore: serve the visualizer styles as a standalone stylesheet

- [#657](https://github.com/langchain-ai/openwiki/pull/657) [`e155526`](https://github.com/langchain-ai/openwiki/commit/e15552657e1ce043f8340d89176a2dc4241c1d6b) Thanks [@Aveek-Saha](https://github.com/Aveek-Saha)! - feat: add static export to openwiki visualizer

- [#647](https://github.com/langchain-ai/openwiki/pull/647) [`46d437a`](https://github.com/langchain-ai/openwiki/commit/46d437a4a2a0ad1d212698a75ec1ddd163c9218f) Thanks [@IstPlayer](https://github.com/IstPlayer)! - fix: refresh .last-update.json timestamp on no-op updates so freshness checks reflect the actual last run, preserving the wiki's persisted language across the refresh

- [#699](https://github.com/langchain-ai/openwiki/pull/699) [`337f890`](https://github.com/langchain-ai/openwiki/commit/337f890cf5004f45742e9f41028ef51d84a1d013) Thanks [@colifran](https://github.com/colifran)! - feat: regenerate repository wikis from scratch on init

- [#684](https://github.com/langchain-ai/openwiki/pull/684) [`46c0a3d`](https://github.com/langchain-ai/openwiki/commit/46c0a3d53011a1f4916052187288dc5b4651c292) Thanks [@colifran](https://github.com/colifran)! - fix: finalize OKF generated provenance after wiki post-processing so every body change, including whitespace, receives an accurate stamp while front-matter-only changes preserve the prior stamp

## 0.3.3

### Patch Changes

- [#619](https://github.com/langchain-ai/openwiki/pull/619) [`250296c`](https://github.com/langchain-ai/openwiki/commit/250296ce8907608de734aa3471bcf81870f45c40) Thanks [@DecentralizedJM](https://github.com/DecentralizedJM)! - feat: add built-in custom-mcp connector for arbitrary mcp sources

- [#603](https://github.com/langchain-ai/openwiki/pull/603) [`20f88c9`](https://github.com/langchain-ai/openwiki/commit/20f88c9c60d328737edebbeddc29f79e402f6209) Thanks [@akyourowngames](https://github.com/akyourowngames)! - fix: gate connector tools to personal/local-wiki runs

- [#266](https://github.com/langchain-ai/openwiki/pull/266) [`3dcb382`](https://github.com/langchain-ai/openwiki/commit/3dcb3820b492fbec4ca73275ea69efa37fa76165) Thanks [@ousamabenyounes](https://github.com/ousamabenyounes)! - feat: allow openai-compatible provider to opt into responses api

- [#566](https://github.com/langchain-ai/openwiki/pull/566) [`c5d41cb`](https://github.com/langchain-ai/openwiki/commit/c5d41cbe91fd6105bfbd4a05ec7606708ae22e23) Thanks [@divya0795](https://github.com/divya0795)! - fix: follow `nextCursor` when listing MCP tools, so tools on a paginated server past the first page are discovered and callable instead of rejected as "not returned by tools/list"

- [#621](https://github.com/langchain-ai/openwiki/pull/621) [`239f810`](https://github.com/langchain-ai/openwiki/commit/239f810e6735dd32292ed176ea7ad9c05ed4350e) Thanks [@danielsogl](https://github.com/danielsogl)! - feat: generate the ci workflow env block from the configured provider

- [#635](https://github.com/langchain-ai/openwiki/pull/635) [`9fb0097`](https://github.com/langchain-ai/openwiki/commit/9fb009798a97baf0c0987b08cdac82233c801901) Thanks [@Bubblegunn](https://github.com/Bubblegunn)! - fix: sync bundled skills from read-only installations

- [#550](https://github.com/langchain-ai/openwiki/pull/550) [`f7c9f13`](https://github.com/langchain-ai/openwiki/commit/f7c9f1339fd9c826987d284fbc38869f79bc3f1d) Thanks [@GautamSharma99](https://github.com/GautamSharma99)! - fix: strip terminal control sequences from streamed Markdown output

- [#639](https://github.com/langchain-ai/openwiki/pull/639) [`8e6dc99`](https://github.com/langchain-ai/openwiki/commit/8e6dc9945ba7d1e0e3a734dddfdb843e91d96f63) Thanks [@Christian-Sidak](https://github.com/Christian-Sidak)! - feat: add apac region support for langsmith

- [#622](https://github.com/langchain-ai/openwiki/pull/622) [`2865cd6`](https://github.com/langchain-ai/openwiki/commit/2865cd6432c48ab27c7c834ca08ec0a7d6647086) Thanks [@colifran](https://github.com/colifran)! - feat: add LEDGER, a longitudinal benchmark for wiki grounding and forgetting

- [#491](https://github.com/langchain-ai/openwiki/pull/491) [`4f61f7f`](https://github.com/langchain-ai/openwiki/commit/4f61f7f8b163cac26a00f91a2533e14b1b953387) Thanks [@jyje](https://github.com/jyje)! - feat: validate selected openai models against api-key availability before inference

- [#640](https://github.com/langchain-ai/openwiki/pull/640) [`3a25d09`](https://github.com/langchain-ai/openwiki/commit/3a25d09444b879f358fcd5530ef82911f00905da) Thanks [@Christian-Sidak](https://github.com/Christian-Sidak)! - fix: generate CLAUDE.md as a pointer to AGENTS.md on init

- [#590](https://github.com/langchain-ai/openwiki/pull/590) [`4fc9dff`](https://github.com/langchain-ai/openwiki/commit/4fc9dffa81cebaf60a0e8aa70f7b3565fa7edb3d) Thanks [@pawel-twardziak](https://github.com/pawel-twardziak)! - feat: cap openrouter output tokens with OPENWIKI_OPENROUTER_MAX_TOKENS to avoid 402 errors on low credit balances

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
