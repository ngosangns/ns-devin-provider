// ABOUTME: Grok catalog ids stay off the Devin picker route.

import { describe, expect, it } from "vitest";
import { isGrokCatalogModel, modelBelongsToProvider } from "../src/catalog.js";

describe("modelBelongsToProvider", () => {
  it("recognizes Grok catalog ids, not effort-lane uids filed as their own models", () => {
    expect(isGrokCatalogModel("grok-4-7")).toBe(true);
    expect(isGrokCatalogModel("grok")).toBe(true);
    expect(isGrokCatalogModel("claude-sonnet-5")).toBe(false);
    expect(isGrokCatalogModel("swe-1-6")).toBe(false);
  });

  it("lists Grok models only on the Grok route", () => {
    expect(modelBelongsToProvider("grok-4-7", "grok", "devin", "grok")).toBe(true);
    expect(modelBelongsToProvider("grok-4-7", "devin", "devin", "grok")).toBe(false);
    expect(modelBelongsToProvider("swe-1-6", "devin", "devin", "grok")).toBe(true);
    expect(modelBelongsToProvider("swe-1-6", "grok", "devin", "grok")).toBe(false);
    expect(modelBelongsToProvider("claude-sonnet-5", "devin", "devin", "grok")).toBe(true);
  });

  it("keeps a single list when the Grok route is disabled", () => {
    expect(modelBelongsToProvider("grok-4-7", "devin", "devin", "")).toBe(true);
    expect(modelBelongsToProvider("grok-4-7", "grok", "devin", "")).toBe(false);
    expect(modelBelongsToProvider("grok-4-7", "devin", "devin", "devin")).toBe(true);
  });
});
