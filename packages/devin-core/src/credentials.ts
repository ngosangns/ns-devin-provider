// ABOUTME: The Devin CLI credential store: a flat TOML file at
// ABOUTME: ~/.local/share/devin/credentials.toml shared with `devin auth`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { credentialsFromToken, type DevinCredentials } from "./oauth.js";

/** Keys the CLI credential file carries that this provider reads or writes. */
export interface DevinStoredCredentials {
  /** Cascade session token (`devin-session-token$…` once normalized). */
  apiKey: string;
  /** Cascade API base the CLI recorded at login; overrides the default. */
  apiServerUrl?: string;
  /** Management API base recorded at login. */
  devinApiUrl?: string;
  /** Webapp host recorded at login. */
  devinWebappHost?: string;
}

/** `credentials.toml` location; `DEVIN_CREDENTIALS_PATH` overrides (tests). */
export function devinCredentialsPath(): string {
  const override = process.env.DEVIN_CREDENTIALS_PATH;
  if (override) return override;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "devin", "credentials.toml");
}

/** Parse the flat `key = "value"` TOML the CLI writes. Quoted strings only. */
function parseCredentialsToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const match = /^([\w.-]+)\s*=\s*"(.*)"\s*$/.exec(trimmed);
    if (!match) continue;
    // The CLI writes plain strings; decode the two escapes it can emit.
    out[match[1]] = match[2].replace(/\\(["\\])/g, "$1");
  }
  return out;
}

/**
 * Read the machine's Devin session. Returns `undefined` when the file is
 * missing or carries no usable token — the caller decides whether to prompt.
 */
export function resolveDevinCredentials(): DevinStoredCredentials | undefined {
  let text: string;
  try {
    text = readFileSync(devinCredentialsPath(), "utf8");
  } catch {
    return undefined;
  }
  const fields = parseCredentialsToml(text);
  const apiKey = fields.windsurf_api_key?.trim() || fields.api_key?.trim();
  if (!apiKey) return undefined;
  const trimUrl = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim().replace(/\/+$/, "");
    return trimmed ? trimmed : undefined;
  };
  return {
    apiKey,
    apiServerUrl: trimUrl(fields.api_server_url),
    devinApiUrl: trimUrl(fields.devin_api_url),
    devinWebappHost: trimUrl(fields.devin_webapp_host),
  };
}

/** The session as {@link DevinCredentials}, or `undefined` when logged out. */
export function resolveDevinSession(): DevinCredentials | undefined {
  const stored = resolveDevinCredentials();
  return stored ? credentialsFromToken(stored.apiKey) : undefined;
}

/**
 * Persist a session token so the Devin CLI and this provider share it.
 * Existing unrelated keys in the file are preserved.
 */
export function saveDevinCredentials(apiKey: string, extras?: Partial<DevinStoredCredentials>): void {
  const path = devinCredentialsPath();
  const existing = parseCredentialsToml(
    (() => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    })(),
  );
  existing.windsurf_api_key = apiKey;
  if (extras?.apiServerUrl) existing.api_server_url = extras.apiServerUrl;
  if (extras?.devinApiUrl) existing.devin_api_url = extras.devinApiUrl;
  if (extras?.devinWebappHost) existing.devin_webapp_host = extras.devinWebappHost;
  const body = Object.entries(existing)
    .map(([key, value]) => `${key} = "${value.replace(/(["\\])/g, "\\$1")}"`)
    .join("\n");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${body}\n`, { mode: 0o600 });
}
