// ABOUTME: Devin credentials: PKCE OAuth login against app.devin.ai, and API-key sessions.
// ABOUTME: Devin CLI tokens do not expire by default, so there is no token refresh endpoint to call.

import { createHash, randomBytes } from "node:crypto";
import { DEVIN_MANAGEMENT_BASE_URL, DEVIN_WEBAPP_URL } from "./wire.js";

export type DevinAuthMethod = "oauth" | "apikey";

export interface DevinCredentials {
  /** Bearer token sent on every Cascade and management request. */
  access: string;
  /** Devin CLI tokens are long-lived and carry no refresh token of their own. */
  refresh: string;
  /** Epoch milliseconds; far-future for a token Devin does not expire. */
  expires: number;
  authMethod: DevinAuthMethod;
}

const FALLBACK_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;
const CALLBACK_PORT = 59_653;
const CALLBACK_PATH = "/callback";
const TOKEN_PATH = "/auth/cli/token";

export function isDevinApiKey(token: string): boolean {
  // Devin service-user / PAT tokens use the `cog_` prefix (API v3); a Cascade
  // session string carries no fixed prefix, so anything not shaped like a v3
  // token is treated as an opaque session string rather than rejected.
  return token.startsWith("cog_");
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface DevinPkce {
  verifier: string;
  challenge: string;
}

function generatePkce(): DevinPkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Decode a token's expiry from its JWT `exp` claim; a long fallback otherwise. */
function tokenExpiryMs(token: string): number {
  try {
    const [, payload] = token.split(".");
    if (payload) {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
      if (typeof decoded.exp === "number" && Number.isFinite(decoded.exp)) {
        return decoded.exp * 1000 - 5 * 60 * 1000;
      }
    }
  } catch {
    // Malformed or non-JWT token; fall through to the long-lived default.
  }
  return Date.now() + FALLBACK_EXPIRES_MS;
}

export interface DevinLoginCallbacks {
  /** Open (or print) the URL the user must visit to approve the login. */
  onAuthUrl: (url: string, instructions?: string) => void;
  onProgress?: (message: string) => void;
  /** Milliseconds to wait for the browser round trip before giving up. */
  timeoutMs?: number;
}

/**
 * PKCE login against Devin's own CLI auth flow: a local HTTP server receives
 * the authorization code on `127.0.0.1:59653/callback`, which is then
 * exchanged for a bearer token. Mirrors the flow `devin auth login` runs.
 */
export async function loginDevinWithPkce(callbacks: DevinLoginCallbacks): Promise<DevinCredentials> {
  const { createServer } = await import("node:http");
  const pkce = generatePkce();
  const state = crypto.randomUUID();
  const timeoutMs = callbacks.timeoutMs ?? 5 * 60 * 1000;

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end();
          return;
        }
        const returnedState = url.searchParams.get("state");
        const authCode = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        res.writeHead(200, { "content-type": "text/html" });
        if (error || !authCode || returnedState !== state) {
          res.end("<html><body>Devin login failed. You can close this tab.</body></html>");
          server.close();
          reject(new Error(`Devin login failed: ${error ?? "missing or mismatched state/code"}`));
          return;
        }
        res.end("<html><body>Devin login complete. You can close this tab.</body></html>");
        server.close();
        resolve(authCode);
      } catch (err) {
        try {
          res.writeHead(500).end();
        } catch {}
        server.close();
        reject(err);
      }
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the Devin login callback."));
    }, timeoutMs);
    server.on("close", () => clearTimeout(timer));
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
      const params = new URLSearchParams({
        redirect_uri: redirectUri,
        state,
        prompt: "select_account",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      });
      callbacks.onAuthUrl(
        `${DEVIN_WEBAPP_URL}/auth/cli/continue?${params.toString()}`,
        "Sign in to Devin in your browser.",
      );
    });
  });

  callbacks.onProgress?.("Exchanging authorization code...");
  const token = await exchangeDevinCliToken(code, pkce.verifier);
  return {
    access: token,
    refresh: token,
    expires: tokenExpiryMs(token),
    authMethod: "oauth",
  };
}

export async function exchangeDevinCliToken(
  authorizationCode: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(`${DEVIN_MANAGEMENT_BASE_URL}${TOKEN_PATH}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ code: authorizationCode, code_verifier: codeVerifier }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Devin CLI token exchange failed: ${response.status} ${error}`.trim());
  }
  const data = (await response.json()) as { token?: unknown };
  if (typeof data.token !== "string" || data.token.length === 0) {
    throw new Error("Devin CLI token exchange returned an empty token.");
  }
  return data.token;
}

/** Wrap a raw token (OAuth session or API key) as a long-lived credential. */
export function credentialsFromToken(token: string): DevinCredentials {
  return {
    access: token,
    refresh: token,
    expires: isDevinApiKey(token) ? Date.now() + FALLBACK_EXPIRES_MS : tokenExpiryMs(token),
    authMethod: isDevinApiKey(token) ? "apikey" : "oauth",
  };
}

export function isExpired(credentials: DevinCredentials): boolean {
  return Date.now() >= credentials.expires;
}

/**
 * Devin CLI tokens do not expire by default (see docs: "do not expire by
 * default"), so there is no refresh endpoint — a token that stopped working was
 * revoked, not aged out, and the caller must prompt for a new login rather than
 * silently retrying a refresh call that does not exist upstream.
 */
export async function refreshDevinToken(credentials: DevinCredentials): Promise<DevinCredentials> {
  if (credentials.authMethod === "apikey") return credentials;
  if (!isExpired(credentials)) return credentials;
  throw new Error(
    "The Devin session has expired and Devin issues no refresh token. Sign in again with the OAuth login flow.",
  );
}
