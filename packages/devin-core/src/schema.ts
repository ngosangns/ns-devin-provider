// ABOUTME: JSON-Schema shaping for Devin's Gemini backend, which rejects
// ABOUTME: constructs (type arrays, unsupported keywords) as invalid_argument.

import { isRecord } from "./util.js";

/**
 * Keywords Google's function-calling schema subset does not understand. Their
 * content is folded into `description` where lossless, dropped otherwise.
 */
const GOOGLE_UNSUPPORTED_FIELDS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minProperties",
  "maxProperties",
  "uniqueItems",
  "contains",
  "if",
  "then",
  "else",
  "not",
  "const",
  "examples",
  "default",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedItems",
  "unevaluatedProperties",
  "prefixItems",
]);

/**
 * Recursively normalize a JSON Schema into the subset Gemini's tool endpoint
 * accepts. The important transform: `type: ["number","null"]` union arrays are
 * rewritten to `{type: "number", nullable: true}` — the wire rejects type
 * arrays outright, and `oneOf`/`anyOf` equivalents are only kept when they
 * cannot collapse to nullable.
 */
export function normalizeSchemaForGoogle(value: unknown): unknown {
  return normalizeNode(value);
}

function normalizeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((entry) => normalizeNode(entry));
  if (!isRecord(node)) return node;
  if (node === null) return node;

  const out: Record<string, unknown> = {};
  const liftedNotes: string[] = [];

  for (const [key, raw] of Object.entries(node)) {
    if (GOOGLE_UNSUPPORTED_FIELDS.has(key)) {
      // A dropped keyword whose text is still useful model guidance is folded
      // into the description rather than silently discarded.
      if ((key === "default" || key === "examples" || key === "format") && raw !== undefined) {
        liftedNotes.push(`${key}: ${JSON.stringify(raw)}`);
      }
      continue;
    }
    if (key === "type" && Array.isArray(raw)) {
      // Split the union: `["number","null"]` → type "number" + nullable.
      // A multi-type union with no null folds into anyOf single-typed arms.
      const types = raw.filter((entry): entry is string => typeof entry === "string");
      const concrete = types.filter((entry) => entry !== "null");
      if (types.includes("null")) out.nullable = true;
      if (concrete.length === 1) {
        out.type = concrete[0];
      } else if (concrete.length > 1) {
        out.anyOf = concrete.map((entry) => ({ type: entry }));
      }
      continue;
    }
    if (key === "properties") {
      if (isRecord(raw)) {
        const properties: Record<string, unknown> = {};
        for (const [name, sub] of Object.entries(raw)) {
          properties[name] = normalizeNode(sub);
        }
        out.properties = properties;
        continue;
      }
    }
    out[key] = normalizeNode(raw);
  }
  // `type: "object"` with no properties is rejected as ambiguous; give it an
  // empty map. Same for a property-less `properties`-bearing schema.
  if (out.type === "object" && !isRecord(out.properties)) out.properties = {};
  if (isRecord(out.properties) && out.type === undefined) out.type = "object";

  if (liftedNotes.length > 0) {
    const note = `(${liftedNotes.join("; ")})`;
    out.description = typeof out.description === "string" && out.description ? `${out.description} ${note}` : note;
  }
  return out;
}

/**
 * Best-effort Gemini-route detection: router-assigned enum uids carry the
 * server's own namespace (`MODEL_GOOGLE_GEMINI_*`), which no id parser sees.
 */
export function isGeminiRoutedModel(...candidates: (string | undefined)[]): boolean {
  return candidates.some(
    (candidate) =>
      candidate !== undefined && (candidate.startsWith("MODEL_GOOGLE_GEMINI_") || /gemini/i.test(candidate)),
  );
}
