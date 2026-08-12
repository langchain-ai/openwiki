/**
 * Strips ANSI SGR escape sequences from a rendered Ink frame so tests can assert
 * on plain text. The ESC byte is built via String.fromCharCode to avoid encoding
 * a raw control character in source.
 */
export function stripAnsi(frame: string | undefined): string {
  const esc = String.fromCharCode(27);
  const pattern = new RegExp(`${esc}\\[[0-9;]*m`, "gu");

  return (frame ?? "").replace(pattern, "");
}
