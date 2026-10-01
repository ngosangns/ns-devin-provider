// ABOUTME: Devin model discovery — GetCliModelConfigs under the pinned CLI
// ABOUTME: identity, normalized onto DevinModelSpec with effort-lane collapse.

import { DEVIN_GET_CLI_MODEL_CONFIGS_PATH, type FetchImpl } from "./client.js";
import {
  type ClientModelConfig,
  DisplayOption,
  GetCliModelConfigsRequestSchema,
  GetCliModelConfigsResponseSchema,
  MetadataSchema,
  ModelDimensionKind,
} from "./proto/devin-messages.js";
import { create, toBinary } from "./proto/protobuf.js";
import { decodeDevinUnaryMessage } from "./proto/wire-helpers.js";
import { DEVIN_EFFORT_ORDER, type DevinCost, type DevinEffort, type DevinModelSpec } from "./types.js";
import { logger } from "./util.js";
import { DEVIN_DEFAULT_BASE_URL, devinDiscoveryMetadata } from "./wire.js";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

/**
 * `DISPLAY_OPTION_INTERNAL_DEFAULT` — display slot for configs the server only
 * reveals to clients that opt in, used for internal default/eval models.
 *
 * The vendored enum predates display options 6-8, so the generated
 * `DisplayOption` stops at `QUICK_REVIEW` (4). Wire display options are plain
 * int32, so the extra values decode faithfully; casting keeps generated code
 * untouched.
 */
const DEVIN_DISPLAY_OPTION_INTERNAL_DEFAULT = 6 as DisplayOption;
/** Unclassified native display slot: requested for parity, never filtered on. */
const DEVIN_DISPLAY_OPTION_UNCLASSIFIED = 7 as DisplayOption;
/** Second visible-model slot, used beside `UNSPECIFIED` (0) for normal models. */
const DEVIN_DISPLAY_OPTION_NORMAL = 8 as DisplayOption;

/**
 * Display slots the native client advertises. `UNSPECIFIED` (0) is implicit.
 * Asking for the internal slots is what makes the server return its full
 * catalog; internal ones are filtered client-side, exactly as native does.
 */
const DEVIN_SUPPORTED_MODEL_DISPLAYS: readonly DisplayOption[] = [
  DisplayOption.MODEL_ROUTER,
  DisplayOption.QUICK_REVIEW,
  DEVIN_DISPLAY_OPTION_INTERNAL_DEFAULT,
  DEVIN_DISPLAY_OPTION_UNCLASSIFIED,
  DEVIN_DISPLAY_OPTION_NORMAL,
];

/** Display slots requested but never surfaced: quick-review and internal defaults. */
const DEVIN_INTERNAL_MODEL_DISPLAYS: ReadonlySet<DisplayOption> = new Set([
  DisplayOption.QUICK_REVIEW,
  DEVIN_DISPLAY_OPTION_INTERNAL_DEFAULT,
]);

/** Best-effort match for labels whose wording implies a reasoning variant. */
const REASONING_LABEL_PATTERN = /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL_PATTERN = /\bno thinking\b/i;

/**
 * Server model features are authoritative for reasoning support; the label
 * heuristic only covers configs that ship no `modelFeatures` at all.
 */
function supportsDevinThinking(config: ClientModelConfig): boolean {
  const features = config.modelInfo?.modelFeatures;
  if (features !== undefined) return features.supportsThinking;
  if (NO_REASONING_LABEL_PATTERN.test(config.label)) return false;
  return REASONING_LABEL_PATTERN.test(config.label);
}

const DEVIN_COST_LABEL_INPUT = "input";
const DEVIN_COST_LABEL_CACHE_READ = "cached input";
const DEVIN_COST_LABEL_OUTPUT = "output";
/** Normalized label of the marker dimension separating composite rate cards. */
const DEVIN_SIDEKICK_LABEL = "sidekick";

const DEVIN_COST_DENOMINATOR_PATTERN = /(\d+(?:\.\d+)?)\s*([kmb])?/i;
const DEVIN_COST_DENOMINATOR_SCALE: Readonly<Partial<Record<string, number>>> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
};

/** Tokens covered by one cost dimension ("1M tokens" → 1_000_000). */
function devinCostDenominatorTokens(denominator: string): number {
  const match = DEVIN_COST_DENOMINATOR_PATTERN.exec(denominator);
  if (match === null) return 1_000_000;
  const suffix = match[2];
  const scale = suffix === undefined ? 1 : (DEVIN_COST_DENOMINATOR_SCALE[suffix.toLowerCase()] ?? 1);
  const tokens = Number(match[1]) * scale;
  return tokens > 0 ? tokens : 1_000_000;
}

/**
 * Per-million-token rates from the config's cost dimensions. `cacheWrite` has
 * no Cascade dimension — Devin bills cache writes at the input rate — and
 * stays 0. Composite (`fusion`) rate cards stop at the `Sidekick` marker
 * dimension: a headline card may omit dimensions a component includes, which
 * makes repeated-label detection unreliable past that point.
 */
function devinModelCost(config: ClientModelConfig): DevinCost {
  const cost: DevinCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const dimension of config.modelDimensions) {
    const label = dimension.label.trim().toLowerCase();
    if (label === DEVIN_SIDEKICK_LABEL) break;
    if (dimension.kind !== ModelDimensionKind.COST && dimension.kind !== ModelDimensionKind.COST_FUZZY) continue;
    // Dimension values arrive as protobuf floats: round off float32 noise
    // (0.1 decodes as 0.10000000149011612) at sub-cent precision.
    const perMillion =
      Math.round(((dimension.value * 1_000_000) / devinCostDenominatorTokens(dimension.denominator)) * 1e6) / 1e6;
    switch (label) {
      case DEVIN_COST_LABEL_INPUT:
        cost.input = perMillion;
        break;
      case DEVIN_COST_LABEL_CACHE_READ:
        cost.cacheRead = perMillion;
        break;
      case DEVIN_COST_LABEL_OUTPUT:
        cost.output = perMillion;
        break;
    }
  }
  return cost;
}

/** `modelFamilyMetadata` entry keys that carry the family's effort axis. */
const DEVIN_FAMILY_EFFORT_KEYS: Readonly<Partial<Record<string, true>>> = { effort: true, "reasoning effort": true };
/** `modelFamilyMetadata` entry key for the service-tier axis; order 1 is the fast lane. */
const DEVIN_FAMILY_FAST_KEY = "fast mode";
const DEVIN_FAMILY_FAST_ORDER = 1;
/** Boolean reasoning axis used by Claude families whose effort name alone is ambiguous. */
const DEVIN_FAMILY_THINKING_KEY = "thinking";
const DEVIN_FAMILY_THINKING_ORDER = 1;
/** Context-window axis; order 1 selects the separate 1M-context lane. */
const DEVIN_FAMILY_CONTEXT_1M_KEY = "1m context";
const DEVIN_FAMILY_CONTEXT_1M_ORDER = 1;

/** Effort-entry display names, normalized space-free, mapped onto efforts. */
const DEVIN_FAMILY_EFFORT_BY_NAME: Readonly<Partial<Record<string, DevinEffort | "off">>> = {
  none: "off",
  nothinking: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * One server-declared family lane. Fast service and 1M context are separate
 * logical models; reasoning effort remains the lane's only selectable axis.
 */
interface DevinFamilyLane {
  /** Logical id: normalized family label plus optional `-1m` / `-fast` suffixes. */
  id: string;
  name: string;
  /** Member wire uids in server order. */
  members: string[];
  /** Wire uid the server marks as the family default, when it declares one. */
  defaultMember?: string;
  /** Effort (or `"off"`) → member wire uid; first claim wins. */
  routing: Partial<Record<DevinEffort | "off", string>>;
}

/**
 * File `config` under its server-declared family lane. Configs with no family
 * metadata, or whose family carries no effort axis, stay standalone specs.
 */
function collectDevinFamilyLane(lanes: Map<string, DevinFamilyLane>, config: ClientModelConfig, uid: string): void {
  const metadata = config.modelFamilyMetadata;
  if (metadata === undefined) return;
  const label = metadata.modelFamilyLabel.trim();
  if (!label) return;

  let effort: DevinEffort | "off" | undefined;
  let thinking: boolean | undefined;
  let fast = false;
  let oneMillionContext = false;
  for (const entry of metadata.entries) {
    const value = entry.value;
    if (value === undefined) continue;
    // Keys collapse punctuation to spaces ("Reasoning Effort" -> "reasoning
    // effort"); effort names drop it entirely ("X High" and "XHigh" -> "xhigh").
    const key = entry.key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (key === DEVIN_FAMILY_FAST_KEY) {
      fast = value.order === DEVIN_FAMILY_FAST_ORDER;
      continue;
    }
    if (key === DEVIN_FAMILY_THINKING_KEY) {
      thinking = value.order === DEVIN_FAMILY_THINKING_ORDER;
      continue;
    }
    if (key === DEVIN_FAMILY_CONTEXT_1M_KEY) {
      oneMillionContext = value.order === DEVIN_FAMILY_CONTEXT_1M_ORDER;
      continue;
    }
    if (DEVIN_FAMILY_EFFORT_KEYS[key]) {
      effort = DEVIN_FAMILY_EFFORT_BY_NAME[value.name.toLowerCase().replace(/[^a-z0-9]+/g, "")];
    }
  }
  // Claude's paired non-thinking and thinking configs share the same "High"
  // effort label; its explicit Thinking axis decides whether the route is off.
  if (thinking === false) effort = "off";

  // Family label as a local id: "GPT-5.6 Sol" -> "gpt-5-6-sol".
  const baseId = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!baseId) return;
  const laneId = `${baseId}${oneMillionContext ? "-1m" : ""}${fast ? "-fast" : ""}`;
  let lane = lanes.get(laneId);
  if (lane === undefined) {
    const name = `${label}${oneMillionContext ? " 1M" : ""}${fast ? " Fast" : ""}`;
    lane = { id: laneId, name, members: [], routing: {} };
    lanes.set(laneId, lane);
  }
  lane.members.push(uid);
  if (lane.defaultMember === undefined && (config.isDefaultModelInFamily || metadata.isDefaultModelInFamily)) {
    lane.defaultMember = uid;
  }
  if (effort !== undefined && lane.routing[effort] === undefined) {
    lane.routing[effort] = uid;
  }
}

/** Options for {@link fetchDevinModels}. */
export interface DevinModelDiscoveryOptions {
  /** Session token carried inside `Metadata.apiKey`. */
  apiKey?: string;
  /** Cascade API base URL override. */
  baseUrl?: string;
  /** Request timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: FetchImpl;
}

/**
 * Fetch the account's model catalog through `GetCliModelConfigs` and normalize
 * it onto {@link DevinModelSpec}s. Returns `null` on request/decode failure;
 * `[]` never escapes — an empty-but-200 response is treated as failure so a
 * caller's static seed survives a stale pinned identity.
 */
export async function fetchDevinModels(options: DevinModelDiscoveryOptions): Promise<DevinModelSpec[] | null> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const resolvedBaseUrl = (options.baseUrl ?? DEVIN_DEFAULT_BASE_URL).replace(/\/+$/, "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

  try {
    const request = create(GetCliModelConfigsRequestSchema, {
      metadata: create(MetadataSchema, {
        ...devinDiscoveryMetadata(options.apiKey),
        supportedModelDisplays: [...DEVIN_SUPPORTED_MODEL_DISPLAYS],
      }),
    });
    const response = await (options.fetch ?? fetch)(`${resolvedBaseUrl}${DEVIN_GET_CLI_MODEL_CONFIGS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/proto", "connect-protocol-version": "1", accept: "*/*" },
      body: toBinary(GetCliModelConfigsRequestSchema, request),
      signal,
    });
    if (!response.ok) return null;

    const decoded = decodeDevinUnaryMessage(
      GetCliModelConfigsResponseSchema,
      new Uint8Array(await response.arrayBuffer()),
    );
    if (!decoded) return null;
    const models = normalizeDevinModels(decoded.clientModelConfigs, options.baseUrl);
    if (models.length === 0) {
      logger.warn("Devin returned an empty native model catalog; the pinned CLI identity may be stale", {
        metadata: devinDiscoveryMetadata(undefined),
      });
      return null;
    }
    return models;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wire uids whose configs advertise `supports_images` but whose backend
 * silently drops `ChatMessagePrompt.images`. Verified live (2026-08-14, native
 * CLI identity): SWE-1.6 and SWE-1.6 Fast answer as if no image was attached.
 * Declaring text-only lets hosts use their image fallback instead of silently
 * losing attachments.
 */
const DEVIN_IMAGE_BLIND_UIDS = new Set(["swe-1-6", "swe-1-6-fast"]);

/** One config as a raw (pre-collapse) spec keyed on its wire uid. */
function devinModelSpec(
  config: ClientModelConfig,
  uid: string,
  baseUrl: string,
  isAssignModelRouter: boolean,
): DevinModelSpec {
  const features = config.modelInfo?.modelFeatures;
  const supportsImages =
    (features !== undefined ? features.supportsImages : config.supportsImages) && !DEVIN_IMAGE_BLIND_UIDS.has(uid);
  const input: ("text" | "image")[] = supportsImages ? ["text", "image"] : ["text"];
  const maxOutputTokens = config.modelInfo?.maxOutputTokens ?? 0;
  const spec: DevinModelSpec = {
    id: uid,
    name: config.label.trim() || uid,
    reasoning: supportsDevinThinking(config),
    input,
    // Router configs ship no model features — the model they route to decides
    // tool use. Cascade only serves tool-calling models, so absent features
    // mean tools are available.
    supportsTools: features !== undefined ? features.supportsToolCalls : true,
    cost: devinModelCost(config),
    contextWindow: config.maxTokens > 0 ? config.maxTokens : DEFAULT_CONTEXT_WINDOW,
    maxTokens: maxOutputTokens > 0 ? maxOutputTokens : DEFAULT_MAX_TOKENS,
    baseUrl,
  };
  if (isAssignModelRouter) spec.isModelRouter = true;
  if (features?.supportsParallelToolCalls === true) spec.supportsParallelToolCalls = true;
  const description = config.description?.trim();
  if (description) spec.description = description;
  if (config.isNew) spec.isNew = true;
  if (config.isBeta) spec.isBeta = true;
  if (config.isRecommended) spec.isRecommended = true;
  return spec;
}

/**
 * Collapse each effort-routing lane into one spec: `id` is the lane id,
 * `requestModelId` the server default member, `effortMap` the effort→uid
 * routes. Member uids that are part of the lane's effort routing drop out of
 * the flat list; unrouted members (an `off`-only variant, say) stay standalone.
 */
function collapseDevinLanes(specs: DevinModelSpec[], lanes: Iterable<DevinFamilyLane>): DevinModelSpec[] {
  const byUid = new Map(specs.map((spec) => [spec.id, spec]));
  const consumed = new Set<string>();
  const laneIds = new Set<string>();
  const out: DevinModelSpec[] = [...specs];
  for (const lane of lanes) {
    const efforts = DEVIN_EFFORT_ORDER.filter((effort) => lane.routing[effort] !== undefined);
    if (efforts.length === 0) continue; // nothing to route: members stay standalone
    const defaultMember = lane.defaultMember ?? lane.members[0];
    const template = byUid.get(defaultMember) ?? byUid.get(lane.members[0] ?? "");
    if (template === undefined) continue;
    const effortMap: Partial<Record<DevinEffort, string>> = {};
    for (const effort of efforts) {
      const uid = lane.routing[effort];
      if (uid !== undefined) effortMap[effort] = uid;
    }
    // The tier the native client selects when the family is picked without an
    // explicit effort, recovered from whichever effort routes to the default.
    const defaultEffort = efforts.find((effort) => lane.routing[effort] === defaultMember);
    const laneSpec: DevinModelSpec = {
      ...template,
      id: lane.id,
      name: lane.name,
      requestModelId: defaultMember,
      reasoning: true,
      efforts,
      effortMap,
      ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    };
    out.push(laneSpec);
    for (const uid of lane.members) {
      if (Object.values(effortMap).includes(uid)) {
        consumed.add(uid);
      }
    }
    laneIds.add(lane.id);
  }
  // A standalone member whose wire uid collides with a lane id (an unrouted
  // "no thinking" variant, say) must not produce a duplicate catalog entry —
  // the lane's effortMap is the reachable path into the family.
  return out.filter((spec) => !consumed.has(spec.id) && !(laneIds.has(spec.id) && spec.efforts === undefined));
}

export function normalizeDevinModels(
  configs: readonly ClientModelConfig[],
  baseUrlOverride: string | undefined,
): DevinModelSpec[] {
  const baseUrl = baseUrlOverride ?? DEVIN_DEFAULT_BASE_URL;
  const specs: DevinModelSpec[] = [];
  const seen = new Set<string>();
  const lanes = new Map<string, DevinFamilyLane>();

  for (const config of configs) {
    if (config.disabled) continue;
    const displayOption = config.modelInfo?.displayOption ?? DisplayOption.UNSPECIFIED;
    if (DEVIN_INTERNAL_MODEL_DISPLAYS.has(displayOption)) continue;
    const uid = config.modelUid.trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    const isRouter = displayOption === DisplayOption.MODEL_ROUTER || config.modelInfo?.isModelRouter === true;
    // `isModelRouter` marks two different things: harness-less routing slots
    // (`adaptive`, `subagent-default`) that `AssignModel` resolves into a
    // concrete model, and harness-backed composites (`fusion`,
    // `fusion-sidekick-*`) that are themselves valid chat uids. Only the
    // former take the `AssignModel` path — sending a composite uid there 404s.
    const isAssignModelRouter = isRouter && (config.modelInfo?.harnessUids.length ?? 0) === 0;
    specs.push(devinModelSpec(config, uid, baseUrl, isAssignModelRouter));
    // A router is a server-side dispatcher, not an effort tier: it stays a
    // standalone model even when upstream files it under a family.
    if (!isRouter) collectDevinFamilyLane(lanes, config, uid);
  }

  return collapseDevinLanes(specs, lanes.values()).sort((a, b) => a.id.localeCompare(b.id));
}
