import { describe, expect, it } from "vitest";
import { normalizeDevinModels } from "../src/discovery.js";
import {
  ClientModelConfigSchema,
  DisplayOption,
  ModelDimensionKind,
  ModelDimensionSchema,
  ModelFamilyMetadataEntrySchema,
  ModelFamilyMetadataSchema,
  ModelFamilyMetadataValueSchema,
  ModelFeaturesSchema,
  ModelInfoSchema,
} from "../src/proto/devin-messages.js";
import { create } from "../src/proto/protobuf.js";

function config(fields: Partial<import("../src/proto/devin-messages.js").ClientModelConfig>) {
  return create(ClientModelConfigSchema, fields);
}

function features(
  supportsThinking: boolean,
  extras: Partial<import("../src/proto/devin-messages.js").ModelFeatures> = {},
) {
  return create(ModelFeaturesSchema, { supportsThinking, supportsToolCalls: true, ...extras });
}

describe("normalizeDevinModels", () => {
  it("maps a plain config to a spec", () => {
    const models = normalizeDevinModels(
      [
        config({
          label: "SWE-1.7",
          modelUid: "swe-1-7",
          maxTokens: 400_000,
          modelInfo: create(ModelInfoSchema, {
            modelFeatures: features(true, { supportsImages: true, supportsParallelToolCalls: true }),
            maxOutputTokens: 128_000,
          }),
        }),
      ],
      undefined,
    );
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "swe-1-7",
      name: "SWE-1.7",
      reasoning: true,
      input: ["text", "image"],
      supportsTools: true,
      supportsParallelToolCalls: true,
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("drops disabled and internal-display configs", () => {
    const models = normalizeDevinModels(
      [
        config({ label: "off", modelUid: "off", disabled: true }),
        config({
          label: "internal",
          modelUid: "internal",
          modelInfo: create(ModelInfoSchema, { displayOption: 6 as DisplayOption }),
        }),
        config({ label: "live", modelUid: "live" }),
      ],
      undefined,
    );
    expect(models.map((m) => m.id)).toEqual(["live"]);
  });

  it("marks a harness-less router for AssignModel but not a harness composite", () => {
    const models = normalizeDevinModels(
      [
        config({
          label: "Adaptive",
          modelUid: "adaptive",
          modelInfo: create(ModelInfoSchema, { displayOption: DisplayOption.MODEL_ROUTER }),
        }),
        config({
          label: "Fusion",
          modelUid: "fusion",
          modelInfo: create(ModelInfoSchema, {
            displayOption: DisplayOption.MODEL_ROUTER,
            harnessUids: ["harness-1"],
          }),
        }),
      ],
      undefined,
    );
    expect(models.find((m) => m.id === "adaptive")?.isModelRouter).toBe(true);
    expect(models.find((m) => m.id === "fusion")?.isModelRouter).toBeUndefined();
  });

  it("collapses an effort family into one spec with an effortMap", () => {
    const family = (uid: string, label: string, effortName: string, isDefault = false) =>
      config({
        label: uid,
        modelUid: uid,
        isDefaultModelInFamily: isDefault,
        modelInfo: create(ModelInfoSchema, { modelFeatures: features(true) }),
        modelFamilyMetadata: create(ModelFamilyMetadataSchema, {
          modelFamilyLabel: label,
          entries: [
            create(ModelFamilyMetadataEntrySchema, {
              key: "Reasoning Effort",
              value: create(ModelFamilyMetadataValueSchema, { order: 1, name: effortName }),
            }),
          ],
        }),
      });
    const models = normalizeDevinModels(
      [
        family("sol-low-uid", "GPT-5.6 Sol", "Low"),
        family("sol-high-uid", "GPT-5.6 Sol", "High", true),
        config({ label: "plain", modelUid: "plain" }),
      ],
      undefined,
    );
    const lane = models.find((m) => m.id === "gpt-5-6-sol");
    expect(lane).toMatchObject({
      name: "GPT-5.6 Sol",
      requestModelId: "sol-high-uid",
      reasoning: true,
      efforts: ["low", "high"],
      effortMap: { low: "sol-low-uid", high: "sol-high-uid" },
      defaultEffort: "high",
    });
    // Routed members are absorbed into the lane; unrouted stay standalone.
    expect(models.find((m) => m.id === "sol-low-uid")).toBeUndefined();
    expect(models.find((m) => m.id === "plain")?.id).toBe("plain");
  });

  it("splits fast-mode and 1M-context lanes", () => {
    const mk = (uid: string, entries: { key: string; name?: string; order?: number }[]) =>
      config({
        label: uid,
        modelUid: uid,
        modelFamilyMetadata: create(ModelFamilyMetadataSchema, {
          modelFamilyLabel: "Claude Opus",
          entries: entries.map((entry) =>
            create(ModelFamilyMetadataEntrySchema, {
              key: entry.key,
              value: create(ModelFamilyMetadataValueSchema, {
                order: entry.order ?? 0,
                name: entry.name ?? "",
              }),
            }),
          ),
        }),
      });
    const models = normalizeDevinModels(
      [
        mk("opus-low", [{ key: "Reasoning Effort", name: "Low", order: 1 }]),
        mk("opus-fast-high", [
          { key: "Reasoning Effort", name: "High", order: 1 },
          { key: "Fast mode", order: 1 },
        ]),
      ],
      undefined,
    );
    expect(models.find((m) => m.id === "claude-opus")?.effortMap).toEqual({ low: "opus-low" });
    expect(models.find((m) => m.id === "claude-opus-fast")?.effortMap).toEqual({ high: "opus-fast-high" });
  });

  it("parses per-million cost dimensions and stops at the Sidekick marker", () => {
    const models = normalizeDevinModels(
      [
        config({
          label: "priced",
          modelUid: "priced",
          modelDimensions: [
            create(ModelDimensionSchema, {
              label: "Input",
              value: 2.5,
              denominator: "1M tokens",
              kind: ModelDimensionKind.COST,
            }),
            create(ModelDimensionSchema, {
              label: "Output",
              value: 10,
              denominator: "1M tokens",
              kind: ModelDimensionKind.COST_FUZZY,
            }),
            create(ModelDimensionSchema, {
              label: "Cached Input",
              value: 0.25,
              denominator: "1M tokens",
              kind: ModelDimensionKind.COST,
            }),
            create(ModelDimensionSchema, {
              label: "Sidekick",
              value: 0,
              denominator: "",
              kind: ModelDimensionKind.UNSPECIFIED,
            }),
            create(ModelDimensionSchema, {
              label: "Input",
              value: 99,
              denominator: "1M tokens",
              kind: ModelDimensionKind.COST,
            }),
          ],
        }),
      ],
      undefined,
    );
    expect(models[0].cost).toEqual({ input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 0 });
  });
});
