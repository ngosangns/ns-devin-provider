// ABOUTME: Tests the catalog → OMP model-config projection.

import type { DevinModelSpec } from "ns-devin-core";
import { describe, expect, it } from "vitest";
import { toOmpModelConfig } from "../src/models.js";

const spec: DevinModelSpec = {
  id: "gpt-5-6-sol",
  name: "GPT-5.6 Sol",
  requestModelId: "sol-high-uid",
  reasoning: true,
  efforts: ["low", "high"],
  effortMap: { low: "sol-low-uid", high: "sol-high-uid" },
  defaultEffort: "high",
  input: ["text", "image"],
  cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 },
  contextWindow: 400_000,
  maxTokens: 128_000,
};

describe("toOmpModelConfig", () => {
  it("projects the effort ladder onto a thinking config", () => {
    const out = toOmpModelConfig(spec);
    expect(out).toMatchObject({
      id: "gpt-5-6-sol",
      requestModelId: "sol-high-uid",
      reasoning: true,
      thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "high" },
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("omits thinking and requestModelId for a plain model", () => {
    const out = toOmpModelConfig({
      ...spec,
      requestModelId: undefined,
      efforts: undefined,
      effortMap: undefined,
      defaultEffort: undefined,
    });
    expect(out.thinking).toBeUndefined();
    expect(out.requestModelId).toBeUndefined();
  });
});
