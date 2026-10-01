// ABOUTME: Which picker group a Cascade catalog id belongs to.
// ABOUTME: Grok is served by the same session as Devin, but it is not a Devin model.

/**
 * Cascade lists Grok beside SWE and the other families. The id prefix is the
 * stable split: display names change, and effort-lane uids (`grok-4-7-high`)
 * are not catalog ids.
 */
export function isGrokCatalogModel(id: string): boolean {
  return id === "grok" || id.startsWith("grok-");
}

/**
 * Whether `modelId` is listed and resolved on `provider`.
 *
 * An empty `grokProvider`, or one equal to the Devin route, leaves every model
 * on the Devin route. Otherwise Grok ids leave the Devin group.
 */
export function modelBelongsToProvider(
  modelId: string,
  provider: string,
  devinProvider: string,
  grokProvider: string,
): boolean {
  const split = grokProvider.length > 0 && grokProvider !== devinProvider;
  if (!split) return provider === devinProvider;
  const grok = isGrokCatalogModel(modelId);
  if (provider === grokProvider) return grok;
  if (provider === devinProvider) return !grok;
  return false;
}
