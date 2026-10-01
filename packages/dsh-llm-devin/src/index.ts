/**
 * Devin adapter plugin for the DeepSeek Harness LLM seam.
 *
 * Devin speaks Connect server-streaming over `server.codeium.com` — protobuf
 * frames carrying text/thinking/tool-call deltas — which no configurable route
 * can describe, so this registers a real adapter rather than a profile.
 *
 * Sessions come from the machine: `devin auth login` writes
 * `~/.local/share/devin/credentials.toml`, which this plugin reads per request
 * so a CLI token rotation is picked up without a restart.
 *
 * ```yaml
 * - id: llm-devin
 *   name: 'dsh-llm-devin'
 *   config:
 *     provider: devin
 * ```
 *
 * @module dsh-llm-devin
 */

import type { Context } from "@deepseek-ai/cordis";
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { LlmError } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import {
  credentialsFromToken,
  type DevinCredentials,
  isExpired,
  refreshDevinToken,
  resolveDevinCredentials,
} from "ns-devin-core";
import { DevinAdapter } from "./adapter.js";

export { DevinAdapter, type DevinAdapterOptions } from "./adapter.js";
export { toLlmError } from "./errors.js";
export { toDevinMessages } from "./messages.js";

export const name = "llm-devin";

/**
 * Only `llm` is a hard dependency. Cordis's object form of `inject` maps a
 * service name to intercept config rather than marking it optional, and reading
 * an uninjected service throws — so the optional attachment store is picked up
 * through a scoped `ctx.inject` inside {@link apply} instead.
 */
export const inject = ["llm"];

export interface Config {
  /** Provider route to register the adapter under. */
  provider: string;
  /** Display name for selectors and status labels. */
  displayName: string;
}

export const Config: z<Config> = z.object({
  provider: z.string().default("devin").description("Provider route to register the adapter under."),
  displayName: z.string().default("Devin").description("Display name shown in model selectors."),
});

/**
 * Resolve the current session for one request.
 *
 * Sessions are re-read rather than cached: `devin auth` rotates the token from
 * another process, and a cached copy would send a token the service has already
 * replaced. The read is a local file, so the cost is not worth the staleness.
 */
async function currentCredentials(): Promise<DevinCredentials> {
  const stored = resolveDevinCredentials();
  if (!stored) {
    throw new LlmError(
      "No Devin session found. Sign in with `devin auth login`, or paste a Devin API key.",
      "MISSING_CREDENTIAL",
    );
  }
  const credentials = credentialsFromToken(stored.apiKey);
  return isExpired(credentials) ? refreshDevinToken(credentials) : credentials;
}

export function apply(ctx: Context, config: Config): void {
  // Held here rather than read per request: a deployment without the attachment
  // service never mounts it, and reading an uninjected service throws. The
  // scoped fiber below sets it while the service exists and clears it when the
  // service goes away, so an image-capable deployment gains image support
  // without a text-only one failing to boot.
  let attachments: AttachmentStore | undefined;
  ctx.inject(["attachments"], (scope) => {
    attachments = scope.attachments;
    scope.effect(
      () => () => {
        attachments = undefined;
      },
      "dsh-llm-devin attachment store",
    );
  });

  const adapter = new DevinAdapter({
    provider: config.provider,
    displayName: config.displayName,
    credentials: currentCredentials,
    attachments: () => attachments,
  });

  ctx.llm.registerAdapter([config.provider], adapter);
}
