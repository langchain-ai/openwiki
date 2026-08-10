/**
 * Removes HTML tags from a string and returns the remaining plain text.
 *
 * Well-formed tags are removed by stripping `<...>` spans repeatedly until the
 * string stops changing. Any leftover angle brackets are then removed individually,
 * so neither a complete nor a partial tag can survive.
 */
export function stripHtmlTags(input: string): string {
  let previous: string;
  let output = input;

  do {
    previous = output;
    output = output.replace(/<[^>]*>/gu, "");
  } while (output !== previous);

  return output.replace(/[<>]/gu, "");
}
