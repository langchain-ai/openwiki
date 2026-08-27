/**
 * Result of resolving a user-supplied output-language string.
 */
export interface ResolvedLanguage {
  /**
   * The canonical BCP-47 tag when the input is a recognized language, and
   * undefined when the input was empty or not recognized (fall back to English).
   *
   * @default undefined
   */
  language?: string;

  /**
   * A user-facing warning, set only when a non-empty input was provided but
   * could not be recognized as a real language.
   *
   * @default undefined
   */
  warning?: string;
}

/**
 * Validates and canonicalizes an output-language flag using only the built-in
 * Intl APIs, so no dependency is added.
 *
 * getCanonicalLocales rejects malformed tags (wrong length, digits, underscores)
 * by throwing, and DisplayNames distinguishes recognized codes from
 * structurally valid but unknown ones (for example "xx" or "english") by
 * echoing the input back instead of returning a real language name.
 *
 * An unrecognized value resolves to no language plus a warning, so callers fall
 * back to English rather than persisting or prompting with garbage.
 */
export function resolveLanguage(
  input: string | null | undefined,
): ResolvedLanguage {
  const trimmed = input?.trim();

  if (!trimmed) {
    return {};
  }

  try {
    const [canonical] = Intl.getCanonicalLocales(trimmed);
    const primary = new Intl.Locale(canonical).language;
    const displayName = new Intl.DisplayNames(["en"], {
      type: "language",
    }).of(primary);

    if (displayName && displayName.toLowerCase() !== primary.toLowerCase()) {
      return { language: canonical };
    }
  } catch {
    // Malformed tag: fall through to the unrecognized-language warning.
  }

  return {
    warning: `Unrecognized language "${trimmed}"; generating in English. Use a BCP-47 code such as zh-CN, hi, or pt-BR.`,
  };
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
