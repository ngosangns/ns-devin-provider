// ABOUTME: Devin's failure vocabulary — HTTP envelope errors, Connect trailer
// ABOUTME: rejections — plus the classification helpers adapters route on.

import { isRecord, sanitizeText } from "./util.js";

/** An HTTP-level rejection from a Cascade endpoint (`<status> <detail>`). */
export class DevinApiError extends Error {
  readonly status: number;
  readonly operation: string;
  readonly headers: Record<string, string>;

  constructor(message: string, operation: string, status: number, headers?: Record<string, string>) {
    super(message);
    this.name = "DevinApiError";
    this.operation = operation;
    this.status = status;
    this.headers = headers ?? {};
  }
}

/** A wire-level failure: malformed frame, empty body, missing router fields. */
export class DevinProtocolError extends Error {
  readonly kind: "empty-body" | "envelope" | "runtime";
  constructor(message: string, kind: "empty-body" | "envelope" | "runtime" = "runtime") {
    super(message);
    this.name = "DevinProtocolError";
    this.kind = kind;
  }
}

/**
 * A rejection the Connect end-of-stream trailer carried. `contextOverflow`
 * marks the large-history `invalid_argument` recovery case — a host that can
 * compact history should retry with a shorter conversation rather than fail.
 */
export class DevinStreamError extends Error {
  readonly code: string;
  readonly contextOverflow: boolean;
  constructor(message: string, code = "", contextOverflow = false) {
    super(message);
    this.name = "DevinStreamError";
    this.code = code;
    this.contextOverflow = contextOverflow;
  }
}

const MAX_DEVIN_ERROR_DETAIL_CHARS = 4096;
const HTML_ERROR_BODY_PATTERN = /^\s*(?:<!doctype\s+html\b|<html\b)/i;

/** Extract a bounded human error without leaking proxy HTML or binary protobuf. */
function devinErrorDetail(response: Response, payload: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload).trim();
  } catch {
    return undefined;
  }
  if (response.headers.get("content-type")?.toLowerCase().includes("text/html")) return undefined;
  try {
    const decoded: unknown = JSON.parse(text);
    if (isRecord(decoded)) {
      const error = decoded.error;
      if (isRecord(error) && typeof error.message === "string") text = error.message.trim();
      else if (typeof error === "string") text = error.trim();
      else if (typeof decoded.message === "string") text = decoded.message.trim();
    }
  } catch {}
  // Validate after envelope extraction: JSON escapes materialize bytes the
  // raw-source scan cannot see. Any text `sanitizeText` would alter is
  // untrustworthy diagnostics and suppresses to status-only.
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0 || HTML_ERROR_BODY_PATTERN.test(normalized) || sanitizeText(normalized) !== normalized) {
    return undefined;
  }
  if (normalized.length <= MAX_DEVIN_ERROR_DETAIL_CHARS) return normalized;
  // Truncate on a code-point boundary: slicing through a surrogate pair would
  // re-introduce the malformed text the sanitize gate just ruled out.
  const boundaryUnit = normalized.charCodeAt(MAX_DEVIN_ERROR_DETAIL_CHARS - 1);
  const cut =
    boundaryUnit >= 0xd800 && boundaryUnit <= 0xdbff ? MAX_DEVIN_ERROR_DETAIL_CHARS - 1 : MAX_DEVIN_ERROR_DETAIL_CHARS;
  return normalized.slice(0, cut);
}

/** Build an `DevinApiError` from a failed unary/streaming response. */
export function createDevinHttpError(operation: string, response: Response, payload: Uint8Array): DevinApiError {
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const detail = devinErrorDetail(response, payload);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return new DevinApiError(
    `Devin ${operation} error ${status}${detail ? `: ${detail}` : ""}`,
    operation,
    response.status,
    headers,
  );
}

export interface ConnectTrailerError {
  code: string;
  message: string;
  formatted: string;
  /** Summarized Connect error `details` entries, when the trailer carried any. */
  detail?: string;
  /** Raw trailer JSON (truncated) retained for evidence logging. */
  raw: string;
}

/** Upper bound on retained raw-trailer evidence so log entries stay bounded. */
const MAX_TRAILER_EVIDENCE_CHARS = 2000;

function truncateTrailerEvidence(text: string): string {
  return text.length > MAX_TRAILER_EVIDENCE_CHARS ? `${text.slice(0, MAX_TRAILER_EVIDENCE_CHARS)}…` : text;
}

/**
 * Summarize Connect error `details` entries (loosely `{ type, value, debug }`
 * records). Rejections arrive as end-of-stream trailers with no HTTP error
 * body, so any detail payload here is the only server-side evidence available.
 */
function summarizeTrailerDetails(details: unknown): string | undefined {
  if (!Array.isArray(details) || details.length === 0) return undefined;
  let summary = "";
  for (const entry of details) {
    if (!isRecord(entry)) continue;
    const type = typeof entry.type === "string" && entry.type ? entry.type : undefined;
    const value = typeof entry.value === "string" && entry.value ? entry.value : undefined;
    let debug: string | undefined;
    if (entry.debug !== undefined) {
      try {
        debug = typeof entry.debug === "string" ? entry.debug : JSON.stringify(entry.debug);
      } catch {
        debug = undefined;
      }
    }
    const boundedType = type ? truncateTrailerEvidence(type) : undefined;
    const evidence = debug ?? value;
    const boundedEvidence = evidence ? truncateTrailerEvidence(evidence) : undefined;
    let part: string | undefined;
    if (boundedType && boundedEvidence) part = `${boundedType}: ${boundedEvidence}`;
    else part = boundedType ?? boundedEvidence;
    if (!part) continue;
    const next = summary ? `${summary}; ${part}` : part;
    if (next.length > MAX_TRAILER_EVIDENCE_CHARS) return truncateTrailerEvidence(next);
    summary = next;
  }
  return summary || undefined;
}

/**
 * Parse a Connect end-of-stream JSON trailer and return its structured error
 * when it carries `{ error: { code, message } }`, else `null`. The trailer is
 * untrusted server output, so the shape is checked with guards, not asserted.
 */
export function readConnectTrailerError(text: string): ConnectTrailerError | null {
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !("error" in parsed)) return null;
  const err = parsed.error;
  if (!isRecord(err)) return null;
  const code = typeof err.code === "string" ? err.code : "";
  const message = typeof err.message === "string" ? err.message : "";
  if (!code && !message) return null;
  const trailer: ConnectTrailerError = {
    code,
    message,
    formatted: `Devin stream error${code ? ` ${code}` : ""}: ${message}`,
    raw: truncateTrailerEvidence(text),
  };
  const detail = summarizeTrailerDetails(err.details);
  if (detail) {
    trailer.detail = detail;
    trailer.formatted += ` [details: ${detail}]`;
  }
  return trailer;
}

/** Retry-After header (seconds or HTTP-date) → milliseconds, when parseable. */
export function parseRetryAfterMs(headers: Record<string, string>): number | undefined {
  const raw = headers["retry-after"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Statuses that mean the token is wrong, revoked, or missing — never retry. */
export function isDevinAuthError(error: unknown): boolean {
  if (error instanceof DevinApiError) return error.status === 401 || error.status === 403;
  if (error instanceof DevinStreamError) return error.code === "unauthenticated" || error.code === "permission_denied";
  return false;
}

/** 429 or Connect `resource_exhausted` / `quota` rejections. */
export function isDevinRateLimitError(error: unknown): boolean {
  if (error instanceof DevinApiError) return error.status === 429;
  if (error instanceof DevinStreamError) {
    return error.code === "resource_exhausted" || /rate.?limit|quota/i.test(error.message);
  }
  return false;
}

/** Connect codes that mark a transient overloaded backend worth retrying. */
export function isDevinCapacityError(error: unknown): boolean {
  if (error instanceof DevinApiError) return error.status === 502 || error.status === 503 || error.status === 529;
  if (error instanceof DevinStreamError) {
    return (
      error.code === "unavailable" || error.code === "deadline_exceeded" || /capacity|overload/i.test(error.message)
    );
  }
  return false;
}

/** Errors a host may recover from by compacting conversation history. */
export function isDevinContextOverflowError(error: unknown): boolean {
  return error instanceof DevinStreamError && error.contextOverflow;
}
