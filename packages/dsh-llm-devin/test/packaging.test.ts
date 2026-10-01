// ABOUTME: Guards the published shape: a package dsh cannot resolve never registers.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as Record<string, never>;

describe("packaging", () => {
  it("exports a dist entrypoint with types", () => {
    expect(manifest.exports).toMatchObject({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    });
    expect(manifest.files).toContain("dist");
  });
});
