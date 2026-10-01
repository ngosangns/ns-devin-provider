// ABOUTME: Small host-neutral helpers shared across the core: type guards,
// ABOUTME: text sanitizing, a gated logger, and stable id minting.

import { createHash } from "node:crypto";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// CSI/OSC ANSI sequences, then C0 controls (except \t \n), CR, DEL, and C1.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point of this pattern
const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point of this pattern
const CONTROL_PATTERN = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;
const REPLACEMENT_CHAR = "\ufffd";

/**
 * Strip ANSI escape sequences, control characters, and lone surrogates.
 * Content that passes through unchanged keeps its reference — callers probe
 * `sanitizeText(text) !== text` to mean "untrustworthy as diagnostics".
 */
export function sanitizeText(text: string): string {
  const wellFormed = text.toWellFormed();
  const clean = wellFormed === text ? text : wellFormed.replaceAll(REPLACEMENT_CHAR, "");
  return clean.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
}

/** A UUID-shaped string: five hex groups in the canonical 8-4-4-4-12 layout. */
export type DeterministicUuid = `${string}-${string}-${string}-${string}-${string}`;

/**
 * Format the leading 128 bits of `seed`'s SHA-256 digest as a UUID-shaped id.
 * Deterministic, so message ids stay stable across request rebuilds without a
 * persisted seed→id mapping.
 */
export function deterministicUuid(seed: string): DeterministicUuid {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface DevinLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

function devinDebugEnabled(): boolean {
  const value = process.env.NS_DEVIN_DEBUG ?? process.env.DEVIN_DEBUG;
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

function emit(method: "debug" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
  const line = data === undefined ? `[devin] ${message}` : `[devin] ${message} ${safeJson(data)}`;
  console[method === "debug" ? "error" : method](line);
}

function safeJson(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data, (_key, value: unknown) => (typeof value === "bigint" ? Number(value) : value));
  } catch {
    return "";
  }
}

/**
 * Debug/warn sink. `debug` is gated behind `NS_DEVIN_DEBUG`/`DEVIN_DEBUG` so a
 * quiet embed pays nothing; warn/error always reach stderr — a stream failure
 * with no diagnostics is undebuggable against a black-box backend.
 */
export const logger: DevinLogger = {
  debug(message, data) {
    if (devinDebugEnabled()) emit("debug", message, data);
  },
  warn(message, data) {
    emit("warn", message, data);
  },
  error(message, data) {
    emit("error", message, data);
  },
};

/** Tokens that must never reach a prompt or a log line. */
const SENSITIVE_PATTERNS = [
  /\b(sk|pk|key|token|secret|password|bearer|api[_-]?key|credential|authorization)\s*[:=]\s*["']?[\w.$~+-]{6,}["']?/gi,
  /\b(cog_|devin-session-token\$)[\w.$~+-]+/g,
  /\bBearer\s+[\w.$~+-]{6,}/gi,
];

/** Best-effort credential redaction for text bound for the wire or a log. */
export function redactSensitiveCredentials(text: string): string {
  let out = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const separator = match.match(/[:=\s]/)?.index ?? 0;
      return `${match.slice(0, separator + 1)}[REDACTED]`;
    });
  }
  return out;
}

/**
 * Flatten a host's `systemPrompt` (`string | string[] | undefined`) into the
 * non-empty list Cascade wants. Entries are well-formed and credential-scrubbed.
 */
export function normalizeSystemPrompts(systemPrompt: readonly string[] | string | undefined | null): string[] {
  const prompts =
    systemPrompt === undefined || systemPrompt === null
      ? []
      : Array.isArray(systemPrompt)
        ? systemPrompt
        : typeof systemPrompt === "string"
          ? [systemPrompt]
          : [];
  return prompts
    .map((prompt) => redactSensitiveCredentials(prompt.toWellFormed()))
    .filter((prompt) => prompt.trim().length > 0);
}
