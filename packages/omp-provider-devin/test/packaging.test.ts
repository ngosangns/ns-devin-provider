// ABOUTME: Guards the published shape: an extension omp cannot resolve never runs.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as Record<string, never>;

describe("packaging", () => {
  it("declares one extension entry under both manifest keys", () => {
    // omp reads `pkg.omp ?? pkg.pi`; keeping both lets an older pi-era host load
    // the same tarball. They must not drift.
    expect(manifest.omp).toEqual({ extensions: ["./dist/index.js"] });
    expect(manifest.pi).toEqual({ extensions: ["./dist/index.js"] });
  });

  it("ships the built extension entrypoint", () => {
    // `files` lists the tarball contents; forgetting `dist` publishes a shell
    // that installs fine and then fails to load.
    expect(manifest.files).toContain("dist");
  });
});
