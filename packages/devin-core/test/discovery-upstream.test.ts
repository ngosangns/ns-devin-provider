// ABOUTME: Fusion pairing routing and the legacy Windsurf catalog fallback
// ABOUTME: (ported from oh-my-pi 18.3.0 / 18.4.0 Devin discovery).

import { describe, expect, it } from "vitest";
import { fetchDevinModels, normalizeDevinModels } from "../src/discovery.js";
import {
  type ClientModelConfig,
  ClientModelConfigSchema,
  DisplayOption,
  GetCliModelConfigsRequestSchema,
  GetCliModelConfigsResponseSchema,
  ModelFeaturesSchema,
  ModelInfoSchema,
} from "../src/proto/devin-messages.js";
import { create, fromBinary, toBinary } from "../src/proto/protobuf.js";

function chat(uid: string, extras: { maxTokens?: number; parallel?: boolean; maxOutputTokens?: number } = {}) {
  return create(ClientModelConfigSchema, {
    label: uid.toUpperCase(),
    modelUid: uid,
    maxTokens: extras.maxTokens ?? 200_000,
    modelInfo: create(ModelInfoSchema, {
      maxOutputTokens: extras.maxOutputTokens ?? 64_000,
      modelFeatures: create(ModelFeaturesSchema, {
        supportsToolCalls: true,
        supportsParallelToolCalls: extras.parallel ?? false,
      }),
    }),
  });
}

function fusion(uid: string): ClientModelConfig {
  return create(ClientModelConfigSchema, {
    label: uid,
    modelUid: uid,
    maxTokens: 1_000_000,
    modelInfo: create(ModelInfoSchema, {
      isModelRouter: true,
      displayOption: DisplayOption.MODEL_ROUTER,
      harnessUids: ["native"],
    }),
  });
}

describe("Fusion pairings", () => {
  it("route through the live lead with the lead's limits", () => {
    const models = normalizeDevinModels(
      [
        chat("swe-2", { maxTokens: 300_000, parallel: true, maxOutputTokens: 32_000 }),
        fusion("fusion-swe-2-sidekick-x"),
      ],
      undefined,
    );
    const pairing = models.find((m) => m.id === "fusion-swe-2-sidekick-x");
    expect(pairing).toMatchObject({
      requestModelId: "swe-2",
      contextWindow: 300_000,
      maxTokens: 32_000,
      supportsParallelToolCalls: true,
    });
    expect(pairing?.isModelRouter).toBeUndefined();
  });

  it("map a `-fast` lead to its priority lane, then its standard lane", () => {
    const priority = normalizeDevinModels(
      [chat("swe-2"), chat("swe-2-priority"), fusion("fusion-swe-2-fast-sidekick-x")],
      undefined,
    );
    expect(priority.find((m) => m.id === "fusion-swe-2-fast-sidekick-x")?.requestModelId).toBe("swe-2-priority");
    const standard = normalizeDevinModels([chat("swe-2"), fusion("fusion-swe-2-fast-sidekick-x")], undefined);
    expect(standard.find((m) => m.id === "fusion-swe-2-fast-sidekick-x")?.requestModelId).toBe("swe-2");
  });

  it("prefer an exact lead uid that itself ends in -fast", () => {
    const models = normalizeDevinModels(
      [chat("swe-1-6"), chat("swe-1-6-fast"), fusion("fusion-swe-1-6-fast-sidekick-x")],
      undefined,
    );
    expect(models.find((m) => m.id === "fusion-swe-1-6-fast-sidekick-x")?.requestModelId).toBe("swe-1-6-fast");
  });

  it("are not listed when their lead is not live", () => {
    const models = normalizeDevinModels([chat("swe-1-6"), fusion("fusion-gone-sidekick-x")], undefined);
    expect(models.map((m) => m.id)).toEqual(["swe-1-6"]);
  });
});

describe("fetchDevinModels legacy fallback", () => {
  function catalogResponse(configs: ClientModelConfig[]): Response {
    return new Response(
      toBinary(
        GetCliModelConfigsResponseSchema,
        create(GetCliModelConfigsResponseSchema, { clientModelConfigs: configs }),
      ),
      { status: 200 },
    );
  }

  it("uses the editor-identity catalog when native discovery returns only the seed", async () => {
    const identities: { ideName: string; apiKey: string }[] = [];
    const impl = (async (_input: string | URL, init?: RequestInit) => {
      const metadata = fromBinary(GetCliModelConfigsRequestSchema, init?.body as Uint8Array).metadata;
      identities.push({ ideName: metadata?.ideName ?? "", apiKey: metadata?.apiKey ?? "" });
      return metadata?.ideName === "windsurf"
        ? catalogResponse([chat("swe-1-6"), chat("claude-x"), chat("gpt-y")])
        : catalogResponse([chat("swe-1-6"), chat("swe-1-6-fast")]);
    }) as typeof fetch;
    const models = await fetchDevinModels({ apiKey: "sk-ws-1", fetch: impl });
    expect(identities).toEqual([
      { ideName: "chisel", apiKey: "devin-session-token$sk-ws-1" },
      { ideName: "windsurf", apiKey: "sk-ws-1" },
    ]);
    expect(models?.map((m) => m.id)).toEqual(["claude-x", "gpt-y", "swe-1-6"]);
  });

  it("keeps a full native catalog without a second request", async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      return catalogResponse([chat("swe-1-6"), chat("swe-2")]);
    }) as typeof fetch;
    const models = await fetchDevinModels({ apiKey: "tok", fetch: impl });
    expect(calls).toBe(1);
    expect(models?.map((m) => m.id)).toEqual(["swe-1-6", "swe-2"]);
  });

  it("returns null when both identities fail", async () => {
    const impl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    expect(await fetchDevinModels({ apiKey: "tok", fetch: impl })).toBeNull();
  });
});
