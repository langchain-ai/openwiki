import ciInfo from "ci-info";

/**
 * True when the user has opted out via OpenWiki's switch or DO_NOT_TRACK.
 */
export function isTelemetryDisabled(): boolean {
  return (
    isTruthyEnv(process.env.OPENWIKI_TELEMETRY_DISABLED) ||
    isTruthyEnv(process.env.DO_NOT_TRACK)
  );
}

/**
 * True in CI / scheduled contexts. CI runs are still captured, but tagged
 * `execution: "ci"` and sent under the sentinel id so they never inflate human
 * install counts. Detection is delegated to `ci-info`. `OPENWIKI_SCHEDULED` is
 * an explicit escape hatch for our own automation.
 */
export function isCiEnvironment(): boolean {
  return ciInfo.isCI || isTruthyEnv(process.env.OPENWIKI_SCHEDULED);
}

/**
 * Fixed distinct id for CI runs, namespaced by provider (e.g. "ci-github-actions").
 * Deliberately NOT unique: collapsing every CI run to one id per provider keeps
 * ephemeral runners from exploding the distinct count.
 */
export function ciSentinelId(): string {
  const provider = ciInfo.name
    ? ciInfo.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
    : "unknown";

  return `ci-${provider}`;
}

/**
 * Whether the first-run notice is suppressed. Distinct from the send gate the
 * notice is skipped in CI, but events are still sent in CI. Only an explicit
 * opt-out stops sending.
 */
export function noticeSuppressed(): boolean {
  return isTelemetryDisabled() || isCiEnvironment();
}

/**
 * True when running the compiled, published build (from `dist/`); false when
 * running from source (`src/` via tsx, or under vitest). Stamped on every event
 * as `production` so real installed-package usage can be separated from local
 * dev/test runs. Deliberately based on build origin, not `NODE_ENV` — that var
 * is common in developers' own shells and would misclassify real users.
 */
export function isProductionBuild(): boolean {
  return import.meta.url.includes("/dist/");
}

/**
 * Treats "0", "false", and "" as not set; any other value as truthy.
 */
function isTruthyEnv(value?: string): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}
