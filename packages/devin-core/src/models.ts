// ABOUTME: The bootstrap model catalog plus the on-disk cache discovery
// ABOUTME: refreshes — hosts list models before a session token exists.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DevinModelSpec } from "./types.js";
import { DEVIN_DEFAULT_BASE_URL } from "./wire.js";

/**
 * Models a client can offer before discovery has ever succeeded. Mirrors the
 * catalog's published seed — SWE-1.6 is the only family guaranteed reachable
 * without the account-gated `GetCliModelConfigs` call.
 */
export const devinModels: DevinModelSpec[] = [
  {
    id: "swe-1-6",
    name: "SWE-1.6",
    reasoning: true,
    input: ["text"],
    supportsTools: true,
    supportsParallelToolCalls: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 128_000,
    baseUrl: DEVIN_DEFAULT_BASE_URL,
  },
  {
    id: "swe-1-6-fast",
    name: "SWE-1.6 Fast",
    reasoning: true,
    input: ["text"],
    supportsTools: true,
    supportsParallelToolCalls: true,
    cost: { input: 0.3, output: 1.5, cacheRead: 0.03, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 128_000,
    baseUrl: DEVIN_DEFAULT_BASE_URL,
  },
];

export const DEVIN_MODEL_IDS: readonly string[] = devinModels.map((model) => model.id);

/** Where the fetched catalog is cached between processes. */
export function devinModelCachePath(): string {
  const override = process.env.NS_DEVIN_MODEL_CACHE;
  if (override) return override;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "ns-devin-provider", "models.json");
}

interface DevinModelCache {
  fetchedAt: number;
  models: DevinModelSpec[];
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cacheFile: DevinModelCache | undefined;
let cacheLoaded = false;

function loadCacheFile(): DevinModelCache | undefined {
  if (cacheLoaded) return cacheFile;
  cacheLoaded = true;
  try {
    const parsed: unknown = JSON.parse(readFileSync(devinModelCachePath(), "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as DevinModelCache).models) &&
      typeof (parsed as DevinModelCache).fetchedAt === "number"
    ) {
      cacheFile = parsed as DevinModelCache;
    }
  } catch {
    cacheFile = undefined;
  }
  return cacheFile;
}

/**
 * The catalog a request may use: the fetched cache when present, else the
 * bootstrap seed. Callers that need freshness should `updateDevinModelsCache`
 * first and re-read.
 */
export function getCachedModels(): DevinModelSpec[] {
  return loadCacheFile()?.models ?? devinModels;
}

/** Whether the on-disk catalog is older than the refresh TTL (or absent). */
export function isCacheStale(now = Date.now()): boolean {
  const cache = loadCacheFile();
  return cache === undefined || now - cache.fetchedAt > CACHE_TTL_MS;
}

/** Persist a fetched catalog; returns the list now being served. */
export function updateDevinModelsCache(models: DevinModelSpec[], now = Date.now()): DevinModelSpec[] {
  cacheFile = { fetchedAt: now, models };
  cacheLoaded = true;
  try {
    mkdirSync(dirname(devinModelCachePath()), { recursive: true });
    writeFileSync(devinModelCachePath(), JSON.stringify(cacheFile), "utf8");
  } catch {
    // A read-only home dir must not break the request that fetched this
    // catalog — the in-memory copy still serves this process.
  }
  return models;
}

/** Look up one catalog entry by local id or wire uid. */
export function resolveDevinModel(id: string): DevinModelSpec | undefined {
  const models = getCachedModels();
  return (
    models.find((model) => model.id === id) ??
    models.find((model) => model.requestModelId === id) ??
    models.find((model) => model.effortMap && Object.values(model.effortMap).includes(id))
  );
}
