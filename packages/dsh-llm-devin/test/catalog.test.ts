// ABOUTME: Foreign catalog ids stay outside the Devin adapter.

import { describe, expect, it } from "vitest";
import { isDevinCatalogModel } from "../src/catalog.js";

describe("isDevinCatalogModel", () => {
  it("serves Devin's own catalog ids", () => {
    expect(isDevinCatalogModel("swe-1-6")).toBe(true);
    expect(isDevinCatalogModel("adaptive")).toBe(true);
    expect(isDevinCatalogModel("claude-sonnet-5")).toBe(true);
  });

  it("refuses Grok ids that Cascade happens to list", () => {
    expect(isDevinCatalogModel("grok")).toBe(false);
    expect(isDevinCatalogModel("grok-4-7")).toBe(false);
    expect(isDevinCatalogModel("grok-4-7-high")).toBe(false);
  });
});
