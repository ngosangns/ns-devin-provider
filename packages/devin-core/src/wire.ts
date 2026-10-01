// ABOUTME: Devin (Cognition Cascade) wire constants: base URL, session-token
// ABOUTME: framing, and the CLI/discovery client identities the backend gates on.

/** Base host for Devin's Cascade chat API (Connect protocol over HTTP/1.1). */
export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";

/** Base host for the Devin v3 management API (sessions, orgs — not used for chat). */
export const DEVIN_MANAGEMENT_BASE_URL = "https://api.devin.ai";

/** Base host for the Devin web app, used for the OAuth PKCE login page. */
export const DEVIN_WEBAPP_URL = "https://app.devin.ai";

const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

/** `Metadata.os` vocabulary; `process.platform` is fixed for the process lifetime. */
const DEVIN_OS = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
const DEVIN_LOCALE = "en";

/**
 * Released Devin CLI request identity. The backend gates behavior on this
 * tuple: `ideType: "chisel"` is what unlocks router assignment (`AssignModel`)
 * and the CLI model surface, which an older/generic identity does not reach.
 */
const DEVIN_CLI_METADATA = {
  ideName: "devin-cli",
  ideType: "chisel",
  ideVersion: "3000.11.3",
  extensionName: "chisel",
  extensionVersion: "3000.11.3",
  locale: DEVIN_LOCALE,
  os: DEVIN_OS,
} as const;

/**
 * Native discovery identity. The Devin CLI announces itself as the `chisel`
 * client on its dev channel for `GetCliModelConfigs`; that identity unlocks
 * the full native config set.
 */
const DEVIN_DISCOVERY_METADATA = {
  ideName: "chisel",
  ideVersion: "0.0.0-dev",
  extensionName: "chisel",
  extensionVersion: "0.0.0-dev",
  locale: DEVIN_LOCALE,
  os: DEVIN_OS,
} as const;

/** Session token as the wire format carries it: the scheme prefix is required. */
export function normalizeDevinSessionToken(apiKey: string | undefined): string {
  if (!apiKey) return "";
  return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

/** Released-CLI metadata with credential bytes already encoded for the wire. */
export function devinWireMetadata(apiKey: string | undefined, userJwt = ""): Record<string, unknown> {
  return {
    apiKey: apiKey ?? "",
    userJwt,
    ...DEVIN_CLI_METADATA,
  };
}

/**
 * Fields for `Metadata` on released-CLI calls (`GetUserJwt`, `AssignModel`,
 * `GetChatMessage`, `GetUserStatus`) authenticated by a Devin session token.
 */
export function devinCliMetadata(apiKey: string | undefined, userJwt = ""): Record<string, unknown> {
  return devinWireMetadata(normalizeDevinSessionToken(apiKey), userJwt);
}

/** Fields for `Metadata` on the dev-channel `GetCliModelConfigs` call. */
export function devinDiscoveryMetadata(apiKey: string | undefined): Record<string, unknown> {
  return {
    apiKey: normalizeDevinSessionToken(apiKey),
    ...DEVIN_DISCOVERY_METADATA,
  };
}
