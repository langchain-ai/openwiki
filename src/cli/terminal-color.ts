import chalk from "chalk";

/**
 * True when the environment declares that the terminal renders ANSI color.
 *
 * `FORCE_COLOR` (non-empty) takes precedence; `NO_COLOR` (non-empty, per
 * no-color.org) declares the opposite. Otherwise only a non-empty `TERM` or
 * `COLORTERM` counts. The detection chain behind Ink's styles treats a
 * present-but-empty variable as a capability signal, so a terminal that never
 * declared color support still gets resolved styling; the "gray" (bright
 * black, SGR 90) used for secondary text can then render as the same color as
 * the background.
 */
export function declaresColorSupport(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const isSet = (value: string | undefined): boolean =>
    typeof value === "string" && value.trim() !== "";

  if (isSet(env.FORCE_COLOR)) {
    return true;
  }

  if (isSet(env.NO_COLOR)) {
    return false;
  }

  const term = (env.TERM ?? "").trim();
  if (term !== "" && term !== "dumb") {
    return true;
  }

  return isSet(env.COLORTERM);
}

/**
 * Pins chalk's color level to plain (0) when the environment declares no color
 * support, so every renderer falls back to default-colored text instead of
 * emitting styling the terminal may not be able to show. Environments that do
 * declare support keep the level chalk detected on its own. Called once from
 * the CLI entry point, before any TUI renders.
 */
export function stabilizeColorLevel(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (declaresColorSupport(env)) {
    return;
  }

  chalk.level = 0;
}
