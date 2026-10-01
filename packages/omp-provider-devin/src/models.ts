// ABOUTME: Projects the devin-core catalog onto OMP's provider-model configuration.

import type { Model } from "@oh-my-pi/pi-ai";
import type { DevinModelSpec } from "ns-devin-core";

/** The subset of OMP's `ProviderModelConfig` this provider fills in. */
export interface OmpDevinModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  thinking?: Model["thinking"];
  input: ("text" | "image")[];
  supportsTools: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  /**
   * Wire uid Devin accepts, when it differs from `id` — collapsed family
   * lanes carry their server-default member uid here so a request can reach
   * the right model without re-deriving the family routing.
   */
  requestModelId?: string;
  description?: string;
}

export function toOmpModelConfig(model: DevinModelSpec): OmpDevinModelConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.efforts?.length
      ? {
          thinking: {
            mode: "effort",
            efforts: [...model.efforts],
            ...(model.defaultEffort ? { defaultLevel: model.defaultEffort } : {}),
          } as Model["thinking"],
        }
      : {}),
    input: [...model.input],
    supportsTools: model.supportsTools !== false,
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.requestModelId !== undefined ? { requestModelId: model.requestModelId } : {}),
    ...(model.description !== undefined ? { description: model.description } : {}),
  };
}
