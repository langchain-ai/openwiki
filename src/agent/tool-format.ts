export function formatToolCallName(name: string): string {
  return name === "execute" ? "Execute" : name;
}

export function formatToolArgs(input: unknown): string {
  const value = parseStringifiedJson(input);

  if (Array.isArray(value)) {
    return value.map(formatToolValue).join(", ");
  }

  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, argValue]) => `${key}=${formatToolValue(argValue)}`)
      .join(", ");
  }

  if (value === undefined || value === null) {
    return "";
  }

  return formatToolValue(value);
}

export function formatToolValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  return JSON.stringify(value) ?? String(value);
}

export function createSyntheticToolCallId(
  name: string,
  input: unknown,
): string {
  return `${name}:${formatToolValue(input)}`;
}

function parseStringifiedJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
