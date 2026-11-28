/**
 * Shared model-facing rule for the href form of internal wiki links.
 *
 * Native workers and host integrations both name pages by OpenWiki page paths
 * such as `/openwiki/quickstart.md`; only a page-relative href resolves for
 * coding agents, GitHub's Markdown renderer, local viewers, and OKF consumers,
 * which read a leading `/` as the bundle root rather than the repository root.
 */
export const WIKI_LINK_GUIDANCE = `For Markdown links to wiki pages or repository files, use hrefs relative to this
page's directory. Paths such as /openwiki/quickstart.md in page jobs and tool
calls are OpenWiki page paths, not Markdown link destinations; never write
root-absolute internal hrefs. For example, from
/openwiki/architecture/agent-runtime.md, link to
/openwiki/concepts/model-providers.md as
[Model Providers](../concepts/model-providers.md).`;
