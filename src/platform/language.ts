/**
 * Outcome of classifying a user-supplied output-language string.
 *
 * The unrecognized case stays distinct from the absent one so no caller can
 * quietly treat a typo as "no language requested". Collapsing the two resolves
 * a misspelled flag to English and records English in run state, which a later
 * run is then refused permission to change.
 */
export type ResolvedLanguage =
  | { kind: "absent" }
  | { kind: "resolved"; language: string }
  | { kind: "unrecognized"; input: string; message: string };

/**
 * Classifies an output-language flag using only the built-in Intl APIs, so no
 * dependency is added.
 *
 * getCanonicalLocales rejects malformed tags (wrong length, digits,
 * underscores, non-ASCII) by throwing, and DisplayNames distinguishes
 * recognized codes from structurally valid but unknown ones (for example "xx"
 * or "korean", which BCP-47 permits as a 5-8 letter subtag but has never
 * registered) by echoing the input back instead of returning a real language
 * name.
 */
export function resolveLanguage(
  input: string | null | undefined,
): ResolvedLanguage {
  const trimmed = input?.trim();

  if (!trimmed) {
    return { kind: "absent" };
  }

  try {
    const [canonical] = Intl.getCanonicalLocales(trimmed);
    const primary = new Intl.Locale(canonical).language;
    const displayName = new Intl.DisplayNames(["en"], {
      type: "language",
    }).of(primary);

    if (displayName && displayName.toLowerCase() !== primary.toLowerCase()) {
      return { kind: "resolved", language: canonical };
    }
  } catch {
    // Malformed tag: fall through to the unrecognized-language result.
  }

  return {
    kind: "unrecognized",
    input: trimmed,
    message: `Unrecognized language "${trimmed}". Use a BCP-47 code such as ko, zh-CN, or pt-BR rather than a language name.`,
  };
}

/**
 * Requires the canonical tag for a request an entry point already validated.
 *
 * Every entry point that accepts a language rejects an unrecognized one before
 * any work starts, so an unrecognized value here means a boundary check was
 * skipped. That is a programming error rather than user input, and it throws
 * instead of resolving to English.
 */
export function requireResolvedLanguage(
  input: string | null | undefined,
): string | undefined {
  const resolved = resolveLanguage(input);

  if (resolved.kind === "unrecognized") {
    throw new Error(
      `${resolved.message} This value should have been rejected at the entry point.`,
    );
  }

  return resolved.kind === "resolved" ? resolved.language : undefined;
}

/**
 * Returns a language tag's primary subtag (for example `zh` for `zh-CN`),
 * treating an absent tag as English. Malformed persisted values are returned as
 * written so they cannot accidentally compare equal to a valid requested tag.
 */
export function getPrimaryLanguageSubtag(
  tag: string | null | undefined,
): string {
  if (!tag) return "en";

  try {
    return new Intl.Locale(tag).language;
  } catch {
    return tag;
  }
}
