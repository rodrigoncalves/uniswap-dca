// Logger with content-based redaction: any registered secret is replaced by
// "<redacted>" in any log string, no matter which field it shows up in.
//
// ponytail: the original plan called for a "field allowlist" -- requiring the
// caller to declare every permitted field key up front. That adds ceremony
// (every new log call has to register its keys) without gaining robustness:
// a secret can leak through ANY field, including an error stack trace whose
// format the log author didn't even choose. Content-based redaction covers
// that regardless of key, with less code.
//
// Known limit: only redacts the WHOLE secret. A truncated leak (e.g.
// "...key: 0x1234...") isn't caught. That's acceptable because the real goal
// is to stop a whole RPC URL or API key from showing up in a network error
// log -- which is how this usually leaks -- not to defend against deliberate
// exfiltration of already-compromised secrets.

type LogFields = Record<string, unknown>;

const secrets: string[] = [];

/** Registers a value to be redacted in every future log. Call as soon as the value is known -- logs before registration aren't protected. */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length > 0 && !secrets.includes(value)) {
    secrets.push(value);
  }
}

function redact(input: string): string {
  let out = input;
  for (const secret of secrets) {
    out = out.split(secret).join("<redacted>");
  }
  return out;
}

function fieldToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ""}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatFields(fields?: LogFields): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue; // JSON.stringify(undefined) isn't a string
    safe[key] = redact(fieldToString(value));
  }
  return " " + JSON.stringify(safe);
}

type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, fields?: LogFields): void {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${redact(message)}${formatFields(fields)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};
