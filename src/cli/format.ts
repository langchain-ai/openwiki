import {
  getDefaultModelId,
  OPENWIKI_MODEL_ID_ENV_KEY,
  resolveConfiguredProvider,
} from "../config/constants.js";

/**
 * Reports whether a submitted chat message is the `/exit` command, ignoring
 * surrounding whitespace and case.
 */
export function isExitMessage(message: string): boolean {
  const normalizedMessage = message.trim().toLowerCase();

  return normalizedMessage === "/exit";
}

/**
 * Truncates tool output to fit beside its label on the current terminal,
 * budgeting for the label width and reserving a small margin.
 */
export function truncateLogOutput(content: string, label: string): string {
  const terminalColumns = process.stdout.columns ?? 80;
  const availableColumns = Math.max(24, terminalColumns - label.length - 7);

  return truncateToDisplayLines(content, 2, availableColumns);
}

/**
 * Collapses whitespace and wraps `content` to at most `maxLines` lines of
 * `maxColumns`, marking the final line with an ellipsis when text remains.
 */
export function truncateToDisplayLines(
  content: string,
  maxLines: number,
  maxColumns: number,
): string {
  const normalizedContent = content.replace(/\s+/gu, " ").trim();

  if (normalizedContent.length <= maxColumns) {
    return normalizedContent;
  }

  const lines: string[] = [];
  let remaining = normalizedContent;

  while (remaining.length > 0 && lines.length < maxLines) {
    lines.push(remaining.slice(0, maxColumns));
    remaining = remaining.slice(maxColumns);
  }

  if (remaining.length > 0 && lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    lines[lines.length - 1] =
      lastLine.length > 3 ? `${lastLine.slice(0, -3)}...` : "...";
  }

  return lines.join("\n");
}

/**
 * Abbreviates an absolute path under the home directory to a `~`-prefixed form,
 * leaving other paths unchanged.
 */
export function formatCwd(cwd: string): string {
  const home = process.env.HOME;

  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }

  return cwd;
}

/**
 * Resolves the model id to display, preferring an explicit id, then the model
 * env override, then the configured provider's default.
 */
export function getDisplayModelId(modelId: string | null): string {
  return (
    modelId ??
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
    getDefaultModelId(resolveConfiguredProvider())
  );
}

/**
 * Returns the spinner glyph for an animation frame, cycling through the frames.
 */
export function getSpinnerFrame(frame: number): string {
  const frames = ["-", "\\", "|", "/"];

  return frames[frame % frames.length] ?? "-";
}
