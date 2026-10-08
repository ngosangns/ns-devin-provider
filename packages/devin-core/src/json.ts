// ABOUTME: Tolerant JSON for streaming tool-call arguments: strict parse first,
// ABOUTME: then auto-close a truncated buffer so the UI can render partial args.

/**
 * Parse possibly-incomplete JSON during streaming. Never throws: `{}` for an
 * empty or unrecoverable buffer, and a best-effort auto-closed object for a
 * truncated one — the final `tool_call_end` parse is the authoritative one.
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
  const trimmed = partialJson?.trimStart();
  if (!trimmed) return {} as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const closed = closePartialJson(trimmed);
    if (closed === undefined) return {} as T;
    try {
      return JSON.parse(closed) as T;
    } catch {
      return {} as T;
    }
  }
}

/** Closers (plus a quote when a string is still open) that complete `body`. */
function openClosers(body: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return undefined; // mismatched closer
    }
  }
  return (inString ? '"' : "") + stack.reverse().join("");
}

/**
 * Salvage a truncated JSON buffer by emitting the closers for whatever is
 * still open, cutting the trailing partial token back to a `,`/`:` boundary
 * when it cannot stand as a value. Returns `undefined` when nothing parses.
 */
function closePartialJson(text: string): string | undefined {
  let body = text;
  for (let attempts = 0; attempts < 8; attempts++) {
    const suffix = openClosers(body);
    if (suffix === undefined) return undefined;
    if (suffix.length === 0) return undefined; // complete but unparseable
    const candidate = body + suffix;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Drop the trailing partial token — a half-written string, number, or
      // a dangling `"key":` — back to the last separator or open bracket.
      const cut = Math.max(body.lastIndexOf(","), body.lastIndexOf(":"), body.lastIndexOf("{"), body.lastIndexOf("["));
      if (cut < 0) return undefined;
      body = body.slice(0, cut).replace(/,\s*$/, "");
      if (body.length === 0) return undefined;
    }
  }
  return undefined;
}

/** Default minimum byte growth before a throttled re-parse runs again. */
export const STREAMING_JSON_PARSE_MIN_GROWTH = 256;

/**
 * Throttled variant for the per-delta hot path. The re-parse gate scales
 * geometrically (`len / 32`, floored at `minGrowthBytes`), so a buffer of
 * length N parses O(log N) times instead of O(N) — long `write` payloads made
 * per-delta parsing the dominant stall during streaming.
 */
export function parseStreamingJsonThrottled<T = Record<string, unknown>>(
  partialJson: string | undefined,
  lastParsedLen: number,
  minGrowthBytes: number = STREAMING_JSON_PARSE_MIN_GROWTH,
): { value: T; parsedLen: number } | null {
  const len = partialJson?.length ?? 0;
  if (len === 0) return null;
  const growth = Math.max(minGrowthBytes, len >> 5);
  if (lastParsedLen > 0 && len - lastParsedLen < growth) return null;
  return { value: parseStreamingJson<T>(partialJson), parsedLen: len };
}

/** Longest raw argument text kept in a parse-error diagnostic. */
export const INVALID_ARGUMENTS_RAW_LIMIT = 512;

/**
 * Final, authoritative parse of a completed tool call's arguments. Unlike
 * {@link parseStreamingJson} it never auto-closes a truncated buffer: JSON that
 * was cut off or followed by trailing text yields `{ __parseError, __rawJson }`
 * so no executable keys are recovered from a preview. Empty input is `{}`
 * (zero-argument tools may omit arguments entirely).
 */
export function parseToolCallArguments(json: string | undefined): Record<string, unknown> {
  if (!json?.trim()) return {};
  try {
    const value: unknown = JSON.parse(json);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    throw new Error(`tool arguments must be a JSON object, got ${Array.isArray(value) ? "array" : typeof value}`);
  } catch (error) {
    const raw =
      json.length <= INVALID_ARGUMENTS_RAW_LIMIT
        ? json
        : `${json.slice(0, INVALID_ARGUMENTS_RAW_LIMIT)}… [truncated ${json.length - INVALID_ARGUMENTS_RAW_LIMIT} chars]`;
    return { __parseError: error instanceof Error ? error.message : String(error), __rawJson: raw };
  }
}
