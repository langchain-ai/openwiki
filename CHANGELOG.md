# openwiki

## 0.7.1

### Patch Changes

- [#986](https://github.com/langchain-ai/openwiki/pull/986) [`dcf2cc5`](https://github.com/langchain-ai/openwiki/commit/dcf2cc528d57af5f440c12b81eb0c725c8bcde96) Thanks [@drakeo338](https://github.com/drakeo338)! - fix: accept github line anchors on markdown link targets

- [#974](https://github.com/langchain-ai/openwiki/pull/974) [`d9d7d99`](https://github.com/langchain-ai/openwiki/commit/d9d7d99bba0a98d1aeb6799c5de3cbe38d13e287) Thanks [@xiehuanyi](https://github.com/xiehuanyi)! - fix: strip complete terminal escape sequences

- [#929](https://github.com/langchain-ai/openwiki/pull/929) [`d316820`](https://github.com/langchain-ai/openwiki/commit/d3168204fdf1addb3468f9f737545e44dc94e3a1) Thanks [@c020627](https://github.com/c020627)! - fix: keep every duplicate wiki heading reachable when one already owns the suffix

- [#969](https://github.com/langchain-ai/openwiki/pull/969) [`7b24808`](https://github.com/langchain-ai/openwiki/commit/7b248086701f587e57a7190801e890b38fcd8118) Thanks [@Yi-111-a](https://github.com/Yi-111-a)! - fix: treat compact sequence items as front-matter continuations

- [#980](https://github.com/langchain-ai/openwiki/pull/980) [`0ff41ef`](https://github.com/langchain-ai/openwiki/commit/0ff41eff81d48804345a755abb3aefa2c4c0c0ce) Thanks [@Zhuoxi2000](https://github.com/Zhuoxi2000)! - fix: stamp anchors with malformed percent escapes instead of throwing

- [#958](https://github.com/langchain-ai/openwiki/pull/958) [`fd7ff2a`](https://github.com/langchain-ai/openwiki/commit/fd7ff2aee45076d4386155f13ae7198ffd8fc3ee) Thanks [@breken-ai](https://github.com/breken-ai)! - fix: insert prompt values literally instead of as replacement patterns

- [#913](https://github.com/langchain-ai/openwiki/pull/913) [`1853fbf`](https://github.com/langchain-ai/openwiki/commit/1853fbfbef85aba7786849e3f9db4a7450dabacf) Thanks [@sloemo01](https://github.com/sloemo01)! - fix: retry a page worker once before skipping its page

- [#981](https://github.com/langchain-ai/openwiki/pull/981) [`0b1e992`](https://github.com/langchain-ai/openwiki/commit/0b1e992a37c68f1c54006b4da15ea09e1786152c) Thanks [@tollenceld](https://github.com/tollenceld)! - fix: preserve optional tool parameters for openai-compatible models

- [#865](https://github.com/langchain-ai/openwiki/pull/865) [`8330d7c`](https://github.com/langchain-ai/openwiki/commit/8330d7c6caeac1e67b9f8e3bcda4a4ac4e049b88) Thanks [@HwangJohn](https://github.com/HwangJohn)! - fix: scope update planning to explicit requests

- [#979](https://github.com/langchain-ai/openwiki/pull/979) [`bedcdec`](https://github.com/langchain-ai/openwiki/commit/bedcdec54f17d60d1c9f2452002da08833231417) Thanks [@SammyTourani](https://github.com/SammyTourani)! - fix: serialize concurrent file operations on the same wiki page

- [#957](https://github.com/langchain-ai/openwiki/pull/957) [`16b0aaf`](https://github.com/langchain-ai/openwiki/commit/16b0aafc517253a1a48b5e2363b7bccbb1c3bf11) Thanks [@breken-ai](https://github.com/breken-ai)! - fix: ignore link syntax inside code when validating wiki links

- [#955](https://github.com/langchain-ai/openwiki/pull/955) [`277806a`](https://github.com/langchain-ai/openwiki/commit/277806a834c34ff098ff0dc1552a2bf2f7686b77) Thanks [@Yashwanth-Kumar-Kotla](https://github.com/Yashwanth-Kumar-Kotla)! - fix: prioritize stable workspace ids over display names

- [#989](https://github.com/langchain-ai/openwiki/pull/989) [`bc383a4`](https://github.com/langchain-ai/openwiki/commit/bc383a4845784714e1622867570fa24ac1ad4eff) Thanks [@colifran](https://github.com/colifran)! - fix: update vulnerable dependencies

## 0.7.0

### Minor Changes

- [#966](https://github.com/langchain-ai/openwiki/pull/966) [`0f2060f`](https://github.com/langchain-ai/openwiki/commit/0f2060fe884a3a7bb7cc880c8c4f066267771483) Thanks [@waseem-k-08](https://github.com/waseem-k-08)! - Add a GitHub Copilot CLI integration: `openwiki integrations install copilot`.

- [#975](https://github.com/langchain-ai/openwiki/pull/975) [`c5d7a6d`](https://github.com/langchain-ai/openwiki/commit/c5d7a6d8856e0fce3b471d7509b3fea2a0985edf) Thanks [@colifran](https://github.com/colifran)! - feat: add entra auth configuration and token provider

### Patch Changes

- [#972](https://github.com/langchain-ai/openwiki/pull/972) [`1d09d95`](https://github.com/langchain-ai/openwiki/commit/1d09d9526254dea6be83cbae090dc8db9f70ea30) Thanks [@eugeneliu-86](https://github.com/eugeneliu-86)! - feat: group a repository run's planner and page workers into one LangSmith thread, named "planning agent" and "worker agent: <page>"

## 0.6.1

### Patch Changes

- [#938](https://github.com/langchain-ai/openwiki/pull/938) [`efe6f0f`](https://github.com/langchain-ai/openwiki/commit/efe6f0f62f0ecc1a019aad0d1d2c73f149362ff8) Thanks [@SammyTourani](https://github.com/SammyTourani)! - fix: `--debug` now shows the innermost cause of a failed run, such as the network error behind "Connection error."

- [#937](https://github.com/langchain-ai/openwiki/pull/937) [`261022d`](https://github.com/langchain-ai/openwiki/commit/261022d2db0216a6956df7ff070f380dbf7f2bc2) Thanks [@ind1go](https://github.com/ind1go)! - Correct MCP generation for IBM Bob.

- [#840](https://github.com/langchain-ai/openwiki/pull/840) [`d64ac87`](https://github.com/langchain-ai/openwiki/commit/d64ac8789a41058c66fb456cf3475f77cdcd1168) Thanks [@Yashwanth-Kumar-Kotla](https://github.com/Yashwanth-Kumar-Kotla)! - Fix `.last-update.json` being written non-atomically, which could leave it truncated/corrupted under a failed or concurrent write and silently discard the crash guard's interrupted-status signal.

- [#901](https://github.com/langchain-ai/openwiki/pull/901) [`7495044`](https://github.com/langchain-ai/openwiki/commit/74950440f61eb2bf572234aa28226037aa71bd1c) Thanks [@mbbernstein](https://github.com/mbbernstein)! - fix: flag root-absolute internal wiki links instead of silently accepting them

- [#936](https://github.com/langchain-ai/openwiki/pull/936) [`b3b5ea4`](https://github.com/langchain-ai/openwiki/commit/b3b5ea4359074d164abbd3d4101cb4138c195187) Thanks [@ousamabenyounes](https://github.com/ousamabenyounes)! - Keep repository claim evidence line references in sync when cited blocks move.

- [#902](https://github.com/langchain-ai/openwiki/pull/902) [`3e4ae0c`](https://github.com/langchain-ai/openwiki/commit/3e4ae0ce87d0f9dab10f4d480877c4931a2f4162) Thanks [@mbbernstein](https://github.com/mbbernstein)! - fix: report pages with code-derived frontmatter or no description after index sync

- [#897](https://github.com/langchain-ai/openwiki/pull/897) [`d8ebf56`](https://github.com/langchain-ai/openwiki/commit/d8ebf561f1504cfd068197c8b53ffecfd9a83363) Thanks [@tuandinh0801](https://github.com/tuandinh0801)! - feat: ship openwiki as a native pi package

- [#933](https://github.com/langchain-ai/openwiki/pull/933) [`fbe642d`](https://github.com/langchain-ai/openwiki/commit/fbe642dc01beb6db577de4a9b0072a0fec2866c2) Thanks [@lnhsingh](https://github.com/lnhsingh)! - feat: stop code mode from creating CLAUDE.md

- [#926](https://github.com/langchain-ai/openwiki/pull/926) [`d7a5266`](https://github.com/langchain-ai/openwiki/commit/d7a5266045ffcc551ce5ce6d541b320defc878fe) Thanks [@c020627](https://github.com/c020627)! - fix: keep every OKF wiki operation in `error_detail` instead of dropping four of them

- [#866](https://github.com/langchain-ai/openwiki/pull/866) [`da9a6ae`](https://github.com/langchain-ai/openwiki/commit/da9a6ae1cd4a78f0445923c470429721379573b7) Thanks [@HwangJohn](https://github.com/HwangJohn)! - fix: normalize malformed OpenRouter success responses

- [#906](https://github.com/langchain-ai/openwiki/pull/906) [`7706ef8`](https://github.com/langchain-ai/openwiki/commit/7706ef8e32a8d7d2c4d70458f1e68407bccbd927) Thanks [@Yashwanth-Kumar-Kotla](https://github.com/Yashwanth-Kumar-Kotla)! - Keep repository generation running when a planner submits a different plan after one is already installed.

- [#952](https://github.com/langchain-ai/openwiki/pull/952) [`f0ee52b`](https://github.com/langchain-ai/openwiki/commit/f0ee52b20ac522d181a0fdde4ac26273b5ca8d96) Thanks [@Yashwanth-Kumar-Kotla](https://github.com/Yashwanth-Kumar-Kotla)! - fix: return readable references for wiki introductions

- [#888](https://github.com/langchain-ai/openwiki/pull/888) [`865e9f6`](https://github.com/langchain-ai/openwiki/commit/865e9f645162378defb97b6774baedff72531869) Thanks [@Yashwanth-Kumar-Kotla](https://github.com/Yashwanth-Kumar-Kotla)! - Prevent agents from running arbitrary host shell commands and direct repository inspection through OpenWiki's constrained filesystem tools.

## 0.6.0

### Minor Changes

- [#893](https://github.com/langchain-ai/openwiki/pull/893) [`53fba6b`](https://github.com/langchain-ai/openwiki/commit/53fba6b48ee5fa3fca098f6f8bb1575c11138b2a) Thanks [@tuandinh0801](https://github.com/tuandinh0801)! - feat: add Oh My Pi (`omp`) coding-agent integration

- [#903](https://github.com/langchain-ai/openwiki/pull/903) [`4e84ff0`](https://github.com/langchain-ai/openwiki/commit/4e84ff04a9bfccc94d92fbf4a696a876f8121aa3) Thanks [@eugeneliu-86](https://github.com/eugeneliu-86)! - feat: run repository page workers in parallel

- [#905](https://github.com/langchain-ai/openwiki/pull/905) [`0c0b35d`](https://github.com/langchain-ai/openwiki/commit/0c0b35d333f6b7c9b09dd846e30886515d8c3bc8) Thanks [@colifran](https://github.com/colifran)! - feat: implement openwiki search, read, and link to support queryable wikis over mcp and wiki linking for multi-wiki reads

### Patch Changes

- [#922](https://github.com/langchain-ai/openwiki/pull/922) [`05197b7`](https://github.com/langchain-ai/openwiki/commit/05197b7dd1913c5250a0eecd778e80c49c90dc4c) Thanks [@colifran](https://github.com/colifran)! - feat: add an Antigravity CLI coding-agent integration

- [#932](https://github.com/langchain-ai/openwiki/pull/932) [`b83e1f2`](https://github.com/langchain-ai/openwiki/commit/b83e1f2b40762eceb39fd8de762f2aa39d4d0f47) Thanks [@IgorTodorovskiIBM](https://github.com/IgorTodorovskiIBM)! - fix: stream IBM Bob responses so long generations do not time out

- [#914](https://github.com/langchain-ai/openwiki/pull/914) [`812cb48`](https://github.com/langchain-ai/openwiki/commit/812cb488f4a52ed530592aa1aebcc17b50e8bb2e) Thanks [@drakeo338](https://github.com/drakeo338)! - fix: replace legacy unmarked OpenWiki section instead of appending a duplicate

- [#917](https://github.com/langchain-ai/openwiki/pull/917) [`0f5224f`](https://github.com/langchain-ai/openwiki/commit/0f5224fda800bf6cb3cdca769232e7095e391def) Thanks [@changingshow](https://github.com/changingshow)! - fix: resolve url-encoded filenames in graph links

- [`d3e5f21`](https://github.com/langchain-ai/openwiki/commit/d3e5f21134575f7d1eb02e2075aa45dff895a141) Thanks [@colifran](https://github.com/colifran)! - fix: disable host shell execution in personal mode

## 0.5.2

### Patch Changes

- [#780](https://github.com/langchain-ai/openwiki/pull/780) [`bf7b08b`](https://github.com/langchain-ai/openwiki/commit/bf7b08bea8479d5276131d168be28a1a349ee7a1) Thanks [@caseyg](https://github.com/caseyg)! - feat: add ibm bob as a provider and coding-agent host

- [#869](https://github.com/langchain-ai/openwiki/pull/869) [`9b35620`](https://github.com/langchain-ai/openwiki/commit/9b3562049a9413dfc7f4793c4107c06c873b6e42) Thanks [@radekfojtik](https://github.com/radekfojtik)! - fix: add claude opus 5 to the anthropic and vertex model lists

- [#870](https://github.com/langchain-ai/openwiki/pull/870) [`f71581b`](https://github.com/langchain-ai/openwiki/commit/f71581b28a4df45d017ce3fa3d550e2507afa8f9) Thanks [@pranaypolishetti26](https://github.com/pranaypolishetti26)! - feat: add kiro coding-agent integration

- [#801](https://github.com/langchain-ai/openwiki/pull/801) [`2c90e13`](https://github.com/langchain-ai/openwiki/commit/2c90e13718534c924673bfc1e3c3358f39284969) Thanks [@ousamabenyounes](https://github.com/ousamabenyounes)! - feat: map gemini reasoning effort to thinking level

- [#777](https://github.com/langchain-ai/openwiki/pull/777) [`cf0700f`](https://github.com/langchain-ai/openwiki/commit/cf0700f93c7348acf96cea4ad5fcf182a5fd12cb) Thanks [@danielsogl](https://github.com/danielsogl)! - fix: import AGENTS.md into the managed CLAUDE.md block

- [#863](https://github.com/langchain-ai/openwiki/pull/863) [`fc62fb6`](https://github.com/langchain-ai/openwiki/commit/fc62fb60644f048e2b8b610695d59ad38d568d20) Thanks [@HwangJohn](https://github.com/HwangJohn)! - fix: require Node.js 22.22.0 or newer

- [#788](https://github.com/langchain-ai/openwiki/pull/788) [`4cd2e5f`](https://github.com/langchain-ai/openwiki/commit/4cd2e5f82a3c34ce44b1c0f60bbc61d543a5d8f4) Thanks [@HwangJohn](https://github.com/HwangJohn)! - feat: let openai-compatible opt into reasoning effort

- [#861](https://github.com/langchain-ai/openwiki/pull/861) [`1692ebb`](https://github.com/langchain-ai/openwiki/commit/1692ebbb49cbf5be9c10571596ca5ba79ee758b0) Thanks [@HwangJohn](https://github.com/HwangJohn)! - Normalize redundant nested text content arrays for OpenAI-compatible Chat Completions requests so strict vLLM servers accept replayed tool output.

- [#862](https://github.com/langchain-ai/openwiki/pull/862) [`3994b9a`](https://github.com/langchain-ai/openwiki/commit/3994b9af67fdd2f3074e9933d56f788f3c014df5) Thanks [@HwangJohn](https://github.com/HwangJohn)! - fix: coerce roleless repository worker stream messages

- [#864](https://github.com/langchain-ai/openwiki/pull/864) [`2c6367e`](https://github.com/langchain-ai/openwiki/commit/2c6367e14c4866653c1bac5061cf7b9885aa52ad) Thanks [@HwangJohn](https://github.com/HwangJohn)! - fix: retry transient openrouter provider 404 errors

- [#848](https://github.com/langchain-ai/openwiki/pull/848) [`054db7c`](https://github.com/langchain-ai/openwiki/commit/054db7c9785df7ab18843d10ed029430ecd899ee) Thanks [@kowshikdev](https://github.com/kowshikdev)! - fix: only restamp page-manifest entries a run actually regenerated

- [#872](https://github.com/langchain-ai/openwiki/pull/872) [`11cc526`](https://github.com/langchain-ai/openwiki/commit/11cc52676bf056a3dbe8cbcdb9efa91ac9e14d83) Thanks [@tuandinh0801](https://github.com/tuandinh0801)! - fix: instruct repository planner to invoke submit_plan directly without conversational text

- [#856](https://github.com/langchain-ai/openwiki/pull/856) [`590b1bb`](https://github.com/langchain-ai/openwiki/commit/590b1bb138ba81a63779a551efe3a4c974f9eb9c) Thanks [@radekfojtik](https://github.com/radekfojtik)! - fix: route Vertex AI xAI Grok model IDs to the OpenAI-compatible surface

- [#859](https://github.com/langchain-ai/openwiki/pull/859) [`1b84ea8`](https://github.com/langchain-ai/openwiki/commit/1b84ea88e9ffab44c31939687798a43c05eed2ba) Thanks [@HwangJohn](https://github.com/HwangJohn)! - fix: ignore windows ctime drift while fingerprinting

- [#847](https://github.com/langchain-ai/openwiki/pull/847) [`f4ca24f`](https://github.com/langchain-ai/openwiki/commit/f4ca24f4568c3640fc1c282fdc2d991a06119c96) Thanks [@kowshikdev](https://github.com/kowshikdev)! - fix: add OPENAI_COMPATIBLE_STREAM_MESSAGES_ENV_KEY to MANAGED_ENV_KEYS

- [#881](https://github.com/langchain-ai/openwiki/pull/881) [`8175e29`](https://github.com/langchain-ai/openwiki/commit/8175e29068ab9eb3da942645180570721937c527) Thanks [@marliechorgan](https://github.com/marliechorgan)! - fix: report a claim whose evidence now traverses a symbolic link as unresolved instead of aborting the update

- [#885](https://github.com/langchain-ai/openwiki/pull/885) [`7f81688`](https://github.com/langchain-ai/openwiki/commit/7f81688105272a9b5aa7ea1364899528fd62728e) Thanks [@green-creeper](https://github.com/green-creeper)! - fix: tighter redaction of API keys in CredentialDiagnosticsPanel

## 0.5.1

### Patch Changes

- [#810](https://github.com/langchain-ai/openwiki/pull/810) [`65dbd57`](https://github.com/langchain-ai/openwiki/commit/65dbd575e078b1bece0e9220583cf13f4ea6f212) Thanks [@jkennedyvz](https://github.com/jkennedyvz)! - Modernize runtime and development dependencies, upgrade pnpm, and pin the patched `qs` transitive dependency.

- [#794](https://github.com/langchain-ai/openwiki/pull/794) [`3e180e9`](https://github.com/langchain-ai/openwiki/commit/3e180e9b7d3eb98390e5f63c97a7fe256708b7d8) Thanks [@Yashwanth-Kumar-Kotla](https://github.com/Yashwanth-Kumar-Kotla)! - fix: unescape .env values in a single atomic pass

- [#796](https://github.com/langchain-ai/openwiki/pull/796) [`4364f25`](https://github.com/langchain-ai/openwiki/commit/4364f25ee1ebdf7f4439cc3618d22528fb958daf) Thanks [@Yashwanth-Kumar-Kotla](https://github.com/Yashwanth-Kumar-Kotla)! - fix: allow the google fonts origins the visualizer page requests

- [#832](https://github.com/langchain-ai/openwiki/pull/832) [`2a22e41`](https://github.com/langchain-ai/openwiki/commit/2a22e41dd1e8700e9d5d06f4b119c297b750e52a) Thanks [@smoochy](https://github.com/smoochy)! - feat: show the error stack in the debug diagnostics panel

- [#838](https://github.com/langchain-ai/openwiki/pull/838) [`9a3a2d8`](https://github.com/langchain-ai/openwiki/commit/9a3a2d8725c5049c018917e48e7d8d07fdc26703) Thanks [@ousamabenyounes](https://github.com/ousamabenyounes)! - fix: accept empty-string env vars in MCP connector env resolution

- [#806](https://github.com/langchain-ai/openwiki/pull/806) [`a0c864a`](https://github.com/langchain-ai/openwiki/commit/a0c864a8fc31e15c49ab96258e4851d9142b7baa) Thanks [@colifran](https://github.com/colifran)! - feat: declutter visualizer graph labels

- [#841](https://github.com/langchain-ai/openwiki/pull/841) [`fb3c4c2`](https://github.com/langchain-ai/openwiki/commit/fb3c4c22e512c5e4df99f7013b2b34f04ba4fe0c) Thanks [@mdrxy](https://github.com/mdrxy)! - fix: preserve CLAUDE.md files that only import AGENTS.md

- [#846](https://github.com/langchain-ai/openwiki/pull/846) [`b4a8045`](https://github.com/langchain-ai/openwiki/commit/b4a8045c57c68cb7156e21a984e1e52a0fb1291c) Thanks [@ousamabenyounes](https://github.com/ousamabenyounes)! - fix: render assistant text emitted from top-level model request streams

- [#808](https://github.com/langchain-ai/openwiki/pull/808) [`83ece67`](https://github.com/langchain-ai/openwiki/commit/83ece673a6709e68e98e72cec318d77695fe066d) Thanks [@colifran](https://github.com/colifran)! - fix: update fast-uri to address high severity security vulnerabilities

- [#817](https://github.com/langchain-ai/openwiki/pull/817) [`eb914e2`](https://github.com/langchain-ai/openwiki/commit/eb914e254137568737b130afb9cf7d63e0280129) Thanks [@Christian-Sidak](https://github.com/Christian-Sidak)! - fix: handle updates-mode stream chunks for openai-compatible provider

## 0.5.0

### Minor Changes

- [#720](https://github.com/langchain-ai/openwiki/pull/720) [`6ba64c9`](https://github.com/langchain-ai/openwiki/commit/6ba64c9285384d00a9cea1d7f458261f57129a28) Thanks [@colifran](https://github.com/colifran)! - feat: add durable page-level resumability across local, CI, and host runs

### Patch Changes

- [#743](https://github.com/langchain-ai/openwiki/pull/743) [`0492b5e`](https://github.com/langchain-ai/openwiki/commit/0492b5eecee2e77a05a10f9c162635bdf8c4acf4) Thanks [@Christian-Sidak](https://github.com/Christian-Sidak)! - fix: set maxTokens on Bedrock Converse API calls to avoid 4096-token default cap

- [#414](https://github.com/langchain-ai/openwiki/pull/414) [`e280c17`](https://github.com/langchain-ai/openwiki/commit/e280c1754eec1821e80796cd9ffae354d296f707) Thanks [@bikeusaland](https://github.com/bikeusaland)! - fix: correct git-repo incremental diff and isolate connector ingestion failures

- [#744](https://github.com/langchain-ai/openwiki/pull/744) [`7c3a540`](https://github.com/langchain-ai/openwiki/commit/7c3a540f0feb069f448f662107783e521cc18830) Thanks [@Christian-Sidak](https://github.com/Christian-Sidak)! - fix: force streaming for GitHub Copilot non-GPT-5 models to prevent empty responses from DeepAgents internal invoke calls

- [#748](https://github.com/langchain-ai/openwiki/pull/748) [`2d6a36c`](https://github.com/langchain-ai/openwiki/commit/2d6a36cbfecf01be6443b827604ce9f1941ae16f) Thanks [@easyhak](https://github.com/easyhak)! - feat: add cursor coding-agent integration target

- [#416](https://github.com/langchain-ai/openwiki/pull/416) [`0bd0ac2`](https://github.com/langchain-ai/openwiki/commit/0bd0ac2e90015154d0a90483d588afe5928b4369) Thanks [@bikeusaland](https://github.com/bikeusaland)! - fix: make OpenRouter debug-fetch patch concurrency-safe

- [#789](https://github.com/langchain-ai/openwiki/pull/789) [`84c8d6c`](https://github.com/langchain-ai/openwiki/commit/84c8d6cb14a6dfd899b8f62de3b9f556f3256314) Thanks [@HwangJohn](https://github.com/HwangJohn)! - fix: allow the native repository planner to repeat an accepted plan without aborting the run.

- [#769](https://github.com/langchain-ai/openwiki/pull/769) [`58a1358`](https://github.com/langchain-ai/openwiki/commit/58a1358e1f7d5b883db7405f56dcbdac3c4d7fe5) Thanks [@colifran](https://github.com/colifran)! - feat: reconcile page Claims sparsely so updates retain unaffected Claims without round-tripping their statements and evidence through the model, while exposing complete Claims through optional on-demand inspection

- [#761](https://github.com/langchain-ai/openwiki/pull/761) [`97c6ef0`](https://github.com/langchain-ai/openwiki/commit/97c6ef0ce72912cb3ba70a238a94b2dbc6b3b190) Thanks [@easyhak](https://github.com/easyhak)! - fix: reject an unrecognized `--language` value instead of silently generating an English wiki

- [#767](https://github.com/langchain-ai/openwiki/pull/767) [`06eedd1`](https://github.com/langchain-ai/openwiki/commit/06eedd1dd4ca11d190dd518703d816d873f932f4) Thanks [@forrinzhao](https://github.com/forrinzhao)! - fix: tolerate human-readable "not found" errors from DeepAgents backends when rolling back failed page workers and deleting non-existent pages, instead of aborting the whole run

- [#781](https://github.com/langchain-ai/openwiki/pull/781) [`6be1e01`](https://github.com/langchain-ai/openwiki/commit/6be1e0148fa900cd5fae455d6f759380109a37e1) Thanks [@colifran](https://github.com/colifran)! - fix: tolerate windows stat identity drift while fingerprinting

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
