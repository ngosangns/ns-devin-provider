// Extension entry point: registers the Devin provider with OMP.

import type { Api, Model, OAuthCredentials } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  DEVIN_DEFAULT_BASE_URL,
  type DevinCredentials,
  devinModels,
  fetchDevinModels,
  getCachedModels,
  isCacheStale,
  updateDevinModelsCache,
} from "ns-devin-core";
import { getDevinApiKey, loginDevin, refreshDevinCredentials, resolveRequestCredentials } from "./auth.js";
import { toOmpModelConfig } from "./models.js";
import { streamDevinForOmp } from "./stream.js";
import { devinUsageProvider } from "./usage.js";

export { resolveRequestCredentials } from "./auth.js";
export { toDevinMessages, toDevinTools } from "./messages.js";
export { toOmpModelConfig } from "./models.js";
export { streamDevinForOmp } from "./stream.js";
export { devinUsageProvider, toUsageReport } from "./usage.js";

/**
 * OMP's own catalog cache keys on the provider name and calls this with the
 * resolved key, so discovery runs here rather than through a credential-aware
 * hook. A failed fetch serves what is cached instead of emptying the list.
 */
async function fetchDynamicDevinModels(apiKey: string | undefined) {
  let credentials: Awaited<ReturnType<typeof resolveRequestCredentials>> | undefined;
  try {
    credentials = await resolveRequestCredentials(apiKey);
  } catch {
    // Discovery runs before a login too; the bootstrap catalog stands in
    // until there is a credential to fetch the real one with.
    return getCachedModels().map(toOmpModelConfig);
  }

  if (isCacheStale()) {
    const fetched = await fetchDevinModels({
      apiKey: credentials.apiKey,
      ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
    });
    if (fetched !== null) updateDevinModelsCache(fetched);
  }
  return getCachedModels().map(toOmpModelConfig);
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("devin", {
    baseUrl: DEVIN_DEFAULT_BASE_URL,
    api: "devin-agent" as Api,
    apiKey: "$DEVIN_API_KEY",
    models: devinModels.map(toOmpModelConfig),
    fetchDynamicModels: fetchDynamicDevinModels,
    streamSimple: streamDevinForOmp,
    usage: devinUsageProvider,
    oauth: {
      name: "Devin (OAuth / API key)",
      login: loginDevin,
      refreshToken: refreshDevinCredentials,
      getApiKey: getDevinApiKey,
      modifyModels: (models: Model<Api>[], credentials: OAuthCredentials) => {
        // A credential decides which catalog is actually served, so the model
        // list is re-projected here rather than at registration, when no
        // credential exists yet.
        const devinCredentials = credentials as unknown as DevinCredentials;
        const others = models.filter((model) => model.provider !== "devin");
        const devin = getCachedModels().map(
          (model): Record<string, unknown> => ({
            ...toOmpModelConfig(model),
            api: "devin-agent" as Api,
            provider: "devin",
            baseUrl: model.baseUrl ?? DEVIN_DEFAULT_BASE_URL,
            devinSessionToken: devinCredentials.access,
          }),
        );
        return [...others, ...(devin as unknown as Model<Api>[])];
      },
    },
  });
}
