import { ToolMessage } from "@langchain/core/messages";
import { isCommand, type Command } from "@langchain/langgraph";
import type { BackendProtocolV2 } from "deepagents";
import type { OpenWikiOutputMode } from "../types.js";
import { isWikiMarkdownPath, MUTATION_PATH_METADATA_KEY } from "./utils.js";

const OKF_FIELDS = new Set([
  "type",
  "title",
  "description",
  "resource",
  "tags",
]);
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

export type FrontmatterIssue = {
  code: string;
  line?: number;
  message: string;
};

export type FrontmatterValidation =
  { valid: true } | { issues: FrontmatterIssue[]; valid: false };

type ReadBackend = Pick<BackendProtocolV2, "readRaw">;

export function validateOkfFrontmatter(content: string): FrontmatterValidation {
  const lines = content.split(/\r?\n/u);
  if (lines[0] !== "---") {
    return invalid(
      "missing_opening_delimiter",
      1,
      "File must begin with `---`.",
    );
  }

  const closingLine = lines.indexOf("---", 1);
  if (closingLine === -1) {
    return invalid(
      "missing_closing_delimiter",
      undefined,
      "Opening front matter has no closing `---` delimiter.",
    );
  }

  const issues: FrontmatterIssue[] = [];
  const seen = new Set<string>();

  for (let index = 1; index < closingLine; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const field = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
    if (!field) {
      issues.push(
        issue("invalid_yaml_line", index + 1, "Expected `field: value`."),
      );
      continue;
    }

    const [, key, value] = field;
    if (!OKF_FIELDS.has(key)) {
      issues.push(
        issue("unsupported_field", index + 1, `Unsupported field \`${key}\`.`),
      );
      continue;
    }
    if (seen.has(key)) {
      issues.push(
        issue(
          "duplicate_field",
          index + 1,
          `Field \`${key}\` appears more than once.`,
        ),
      );
      continue;
    }
    seen.add(key);

    const valueError =
      key === "tags" ? validateTags(value) : validateStringScalar(value);
    if (valueError) {
      issues.push(issue(`invalid_${key}`, index + 1, valueError));
    }
  }

  if (!seen.has("type")) {
    issues.push(
      issue("missing_type", undefined, "Required field `type` is missing."),
    );
  }

  return issues.length === 0 ? { valid: true } : { issues, valid: false };
}

export async function addFrontmatterWarning(
  result: ToolMessage | Command,
  backend: ReadBackend,
  outputMode: OpenWikiOutputMode,
  toolName: string,
): Promise<ToolMessage | Command> {
  if (!WRITE_TOOLS.has(toolName)) return result;

  const mutation = getToolMessages(result)
    .map((message) => ({
      message,
      path: message.metadata?.[MUTATION_PATH_METADATA_KEY],
    }))
    .find(
      (item): item is { message: ToolMessage; path: string } =>
        typeof item.path === "string" &&
        isWikiMarkdownPath(item.path, outputMode),
    );
  if (!mutation) return result;

  const validation = await validatePersistedFile(backend, mutation.path);
  if (validation.valid) return result;

  const warning = formatWarning(mutation.path, validation.issues);
  mutation.message.content =
    typeof mutation.message.content === "string"
      ? `${mutation.message.content}\n\n${warning}`
      : [...mutation.message.content, { text: warning, type: "text" }];
  return result;
}

async function validatePersistedFile(
  backend: ReadBackend,
  filePath: string,
): Promise<FrontmatterValidation> {
  const read = await backend.readRaw(filePath);
  const content = read.data?.content;
  if (read.error || content === undefined || content instanceof Uint8Array) {
    return invalid(
      "file_read_failed",
      undefined,
      `Could not read the final Markdown text: ${read.error ?? "no text data"}.`,
    );
  }
  return validateOkfFrontmatter(
    Array.isArray(content) ? content.join("\n") : content,
  );
}

function validateStringScalar(value: string): string | null {
  if (!value) return "Value must be a non-empty YAML string.";
  if (value.startsWith('"')) {
    try {
      return typeof JSON.parse(value) === "string"
        ? null
        : "Value must be a YAML string.";
    } catch {
      return "Double-quoted string is not valid YAML/JSON quoting.";
    }
  }
  if (value.startsWith("'")) {
    if (
      !value.endsWith("'") ||
      value.slice(1, -1).replace(/''/gu, "").includes("'")
    ) {
      return "Single-quoted string is not closed or escaped correctly.";
    }
    return value.length > 2 ? null : "Value must not be empty.";
  }
  if (/^(?:null|~|true|false|[-+]?\d+(?:\.\d+)?)$/iu.test(value)) {
    return "Value must be a string, not a YAML boolean, number, or null.";
  }
  if ("[]{},&*!|>@`".includes(value[0])) {
    return "Value uses YAML collection or tag syntax; provide a string instead.";
  }
  if (/:\s|\s#/u.test(value)) {
    return "Plain string contains YAML syntax; quote the value.";
  }
  return null;
}

function validateTags(value: string): string | null {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    return "Tags must be an inline YAML list, for example `[docs, api]`.";
  }
  const body = value.slice(1, -1).trim();
  if (!body) return null;
  for (const tag of body.split(",")) {
    const error = validateStringScalar(tag.trim());
    if (error) return `Each tag must be a non-empty string: ${error}`;
  }
  return null;
}

function getToolMessages(result: ToolMessage | Command): ToolMessage[] {
  if (!isCommand(result)) return [result];
  const messages = Array.isArray(result.update)
    ? result.update.find(([key]) => key === "messages")?.[1]
    : result.update?.messages;
  return Array.isArray(messages)
    ? messages.filter((message): message is ToolMessage =>
        ToolMessage.isInstance(message),
      )
    : [];
}

function formatWarning(path: string, issues: FrontmatterIssue[]): string {
  const details = issues
    .map(
      ({ code, line, message }) =>
        `- [${code}]${line ? ` line ${line}:` : ""} ${message}`,
    )
    .join("\n");
  return `WARNING: YAML front matter was NOT formatted properly in \`${path}\`.\n${details}\nYou MUST correct this file's YAML front matter before continuing.`;
}

function invalid(
  code: string,
  line: number | undefined,
  message: string,
): FrontmatterValidation {
  return { issues: [issue(code, line, message)], valid: false };
}

function issue(
  code: string,
  line: number | undefined,
  message: string,
): FrontmatterIssue {
  return { code, ...(line ? { line } : {}), message };
}
