// ABOUTME: Login and refresh for OMP's /login flow, over the session the
// ABOUTME: Devin CLI already holds on this machine (~/.local/share/devin).

import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import {
  credentialsFromToken,
  type DevinCredentials,
  isDevinApiKey,
  loginDevinWithPkce,
  refreshDevinToken,
  resolveDevinCredentials,
  saveDevinCredentials,
} from "ns-devin-core";

const NO_SESSION_MESSAGE =
  "No Devin session found. Sign in with `devin auth login`, " +
  "then run /login devin again — or paste a Devin API key (`cog_…`) below.";

/**
 * The interactive flow is Devin's own CLI PKCE login: a browser round trip
 * against app.devin.ai with a loopback callback, then the token is written to
 * the shared `credentials.toml` so `devin` and this plugin stay on one session.
 * An existing CLI session short-circuits the browser entirely; a bare API key
 * is accepted directly.
 */
export async function loginDevin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  callbacks.onProgress?.("Looking for an existing Devin session…");
  const existing = resolveDevinCredentials();
  if (existing) {
    callbacks.onProgress?.("Using the session from the Devin CLI credential store.");
    return credentialsFromToken(existing.apiKey) as unknown as OAuthCredentials;
  }

  callbacks.onProgress?.("Starting Devin sign-in…");
  try {
    const credentials = await loginDevinWithPkce({
      onAuthUrl: (url, instructions) => callbacks.onAuth?.({ url, instructions }),
      onProgress: (message) => callbacks.onProgress?.(message),
      timeoutMs: 5 * 60 * 1000,
    });
    saveDevinCredentials(credentials.access);
    return credentials as unknown as OAuthCredentials;
  } catch (error) {
    // A headless host (no callback port, no browser path) falls back to a
    // pasted API key — the same credential Cascade accepts verbatim.
    if (!callbacks.onPrompt) throw error;
    const apiKey = (
      await callbacks.onPrompt({
        message: `${NO_SESSION_MESSAGE} (Browser sign-in failed: ${error instanceof Error ? error.message : error})`,
        placeholder: "cog_…",
        allowEmpty: true,
        secret: true,
      })
    ).trim();
    if (!apiKey) throw error;
    return credentialsFromToken(apiKey) as unknown as OAuthCredentials;
  }
}

export async function refreshDevinCredentials(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return (await refreshDevinToken(credentials as unknown as DevinCredentials)) as unknown as OAuthCredentials;
}

export function getDevinApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}

/** The token and base URL one request runs on. */
export interface ResolvedDevinRequestCredentials {
  apiKey: string;
  baseUrl?: string;
}

/**
 * Decide which credential a request or catalog fetch runs on.
 *
 * The key OMP resolves for the provider is the session this package returned
 * from `/login devin` — but it is also `$DEVIN_API_KEY` verbatim when that
 * variable is unset, and Devin answers a bogus token with a 401 the core then
 * has to recover from. So a host key is trusted only when it is recognizably a
 * Devin credential; anything else defers to the CLI store, which is where the
 * session actually lives.
 */
export async function resolveRequestCredentials(hostKey: string | undefined): Promise<ResolvedDevinRequestCredentials> {
  const stored = resolveDevinCredentials();
  if (hostKey && (isDevinApiKey(hostKey) || hostKey === stored?.apiKey)) {
    return { apiKey: hostKey, ...(stored?.apiServerUrl ? { baseUrl: stored.apiServerUrl } : {}) };
  }
  if (stored) {
    return { apiKey: stored.apiKey, ...(stored.apiServerUrl ? { baseUrl: stored.apiServerUrl } : {}) };
  }
  if (hostKey) return { apiKey: hostKey };
  throw new Error("Devin credentials not set. Run `devin auth login`, or set DEVIN_API_KEY to a `cog_` API key.");
}
