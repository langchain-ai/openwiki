/**
 * Localized labels for the two deterministic index sections that the OKF index
 * sync renders in every directory's `index.md`.
 */
export interface IndexLabels {
  /**
   * Heading for the list of concept pages in a directory (English "Files").
   */
  files: string;

  /**
   * Heading for the list of subdirectories in a directory (English
   * "Directories").
   */
  directories: string;
}

/**
 * Built-in English labels, used as the structural default whenever a wiki's
 * language is English or has no localized entry in the map below.
 */
export const ENGLISH_INDEX_LABELS: IndexLabels = {
  files: "Files",
  directories: "Directories",
};

/**
 * Localized index section headings keyed by BCP-47 language tag.
 *
 * These two words are structural navigation chrome rather than wiki prose, so
 * they are curated here instead of translated per run: the lookup stays
 * deterministic and model-free, and an unlisted language falls back to English.
 *
 * To localize a language, add one entry. Region-specific forms (for example
 * `zh-CN` versus `zh-TW`) may key on the full tag; a bare primary-subtag entry
 * (for example `zh`) supplies the default for every region of that language.
 */
const INDEX_LABELS: Record<string, IndexLabels> = {
  en: ENGLISH_INDEX_LABELS,
  ar: { files: "ملفات", directories: "مجلدات" },
  bg: { files: "Файлове", directories: "Директории" },
  ca: { files: "Fitxers", directories: "Directoris" },
  cs: { files: "Soubory", directories: "Adresáře" },
  da: { files: "Filer", directories: "Mapper" },
  de: { files: "Dateien", directories: "Verzeichnisse" },
  el: { files: "Αρχεία", directories: "Κατάλογοι" },
  es: { files: "Archivos", directories: "Directorios" },
  fi: { files: "Tiedostot", directories: "Hakemistot" },
  fr: { files: "Fichiers", directories: "Répertoires" },
  he: { files: "קבצים", directories: "תיקיות" },
  hi: { files: "फ़ाइलें", directories: "निर्देशिकाएँ" },
  hr: { files: "Datoteke", directories: "Direktoriji" },
  hu: { files: "Fájlok", directories: "Könyvtárak" },
  id: { files: "Berkas", directories: "Direktori" },
  it: { files: "File", directories: "Cartelle" },
  ja: { files: "ファイル", directories: "ディレクトリ" },
  ko: { files: "파일", directories: "디렉터리" },
  ms: { files: "Fail", directories: "Direktori" },
  nb: { files: "Filer", directories: "Mapper" },
  nl: { files: "Bestanden", directories: "Mappen" },
  no: { files: "Filer", directories: "Mapper" },
  pl: { files: "Pliki", directories: "Katalogi" },
  pt: { files: "Arquivos", directories: "Diretórios" },
  "pt-PT": { files: "Ficheiros", directories: "Diretórios" },
  ro: { files: "Fișiere", directories: "Directoare" },
  ru: { files: "Файлы", directories: "Каталоги" },
  sk: { files: "Súbory", directories: "Adresáre" },
  sl: { files: "Datoteke", directories: "Mape" },
  sr: { files: "Датотеке", directories: "Директоријуми" },
  sv: { files: "Filer", directories: "Kataloger" },
  th: { files: "ไฟล์", directories: "ไดเรกทอรี" },
  tr: { files: "Dosyalar", directories: "Dizinler" },
  uk: { files: "Файли", directories: "Каталоги" },
  vi: { files: "Tập tin", directories: "Thư mục" },
  zh: { files: "文件", directories: "目录" },
  "zh-TW": { files: "檔案", directories: "目錄" },
};

/**
 * Resolves the index section headings for a wiki language.
 *
 * Tries the full canonical tag, then its primary subtag, then falls back to the
 * built-in English labels, so an unlisted or malformed language degrades to
 * English structural headings rather than failing. For example `pt-BR` resolves
 * to the `pt` default while `pt-PT` uses its own override.
 */
export function resolveIndexLabels(language: string | undefined): IndexLabels {
  if (!language) return ENGLISH_INDEX_LABELS;
  return (
    INDEX_LABELS[language] ??
    INDEX_LABELS[primarySubtag(language)] ??
    ENGLISH_INDEX_LABELS
  );
}

/**
 * Built-in English fallback for the concept `type` the code derives when a page
 * has missing or malformed OKF front matter.
 */
export const ENGLISH_CONCEPT_TYPE = "Reference";

/**
 * Localized forms of the derived concept `type` keyed by BCP-47 language tag.
 *
 * `deriveMinimalFrontmatter` stamps this single word onto pages whose front
 * matter it has to repair, so like the index headings it is curated structural
 * chrome rather than translated prose: the lookup stays deterministic and
 * model-free, and an unlisted language falls back to English.
 *
 * To localize a language, add one entry. As with the index labels, a region tag
 * may key on its full form while a bare primary-subtag entry supplies the
 * default for every region of that language.
 */
const CONCEPT_TYPE_LABELS: Record<string, string> = {
  en: ENGLISH_CONCEPT_TYPE,
  ar: "مرجع",
  ca: "Referència",
  cs: "Reference",
  da: "Reference",
  de: "Referenz",
  el: "Αναφορά",
  es: "Referencia",
  fr: "Référence",
  hi: "संदर्भ",
  hr: "Referenca",
  id: "Referensi",
  it: "Riferimento",
  ja: "リファレンス",
  ko: "참조",
  ms: "Rujukan",
  nb: "Referanse",
  nl: "Referentie",
  no: "Referanse",
  pt: "Referência",
  ro: "Referință",
  ru: "Справочник",
  sk: "Referencia",
  sr: "Референца",
  sv: "Referens",
  th: "อ้างอิง",
  tr: "Referans",
  uk: "Довідник",
  vi: "Tham khảo",
  zh: "参考",
  "zh-TW": "參考",
};

/**
 * Resolves the derived concept `type` label for a wiki language.
 *
 * Uses the same full-tag then primary-subtag then English resolution as
 * `resolveIndexLabels`, so an unlisted or malformed language degrades to the
 * English "Reference" rather than failing.
 */
export function resolveConceptTypeLabel(language: string | undefined): string {
  if (!language) return ENGLISH_CONCEPT_TYPE;
  return (
    CONCEPT_TYPE_LABELS[language] ??
    CONCEPT_TYPE_LABELS[primarySubtag(language)] ??
    ENGLISH_CONCEPT_TYPE
  );
}

/**
 * Returns a language tag's primary subtag (for example `zh` for `zh-CN`),
 * echoing the input back when it cannot be parsed.
 */
function primarySubtag(tag: string): string {
  try {
    return new Intl.Locale(tag).language;
  } catch {
    return tag;
  }
}
