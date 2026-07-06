/**
 * Removes HTML tags from a string and returns the remaining plain text.
 *
 * Strips both complete tags (e.g. `<div>`, `</u>`) and a trailing unterminated
 * tag start (e.g. `<script` with no closing `>`).
 */
export function stripHtmlTags(input: string): string {
  return input
    .replace(/<[^>]*>/gu, "") // complete tags: <div>, </u>, <br/>, ...
    .replace(/<[^>]*$/u, ""); // unterminated trailing tag start: "<script"
}
