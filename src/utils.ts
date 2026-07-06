/**
 * Removes HTML tags from a string and returns the remaining plain text.
 *
 * Applies the tag-removal replacement repeatedly until the string stops
 * changing, so removing one tag cannot reveal another that a single pass would
 * miss.
 */
export function stripHtmlTags(input: string): string {
  let previous: string;
  let output = input;

  do {
    previous = output;
    output = output.replace(/<[^>]*>/gu, "");
  } while (output !== previous);

  return output;
}
