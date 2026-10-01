// ABOUTME: Which Cascade catalog ids this adapter will serve.
// ABOUTME: Other vendors in the same payload are outside its job.

/**
 * Cascade returns many vendors in one list. This adapter serves Devin's own
 * entries only. A foreign id is not registered, listed, or turned into an
 * error class here.
 */
const OUTSIDE_DEVIN = /^(?:grok$|grok-)/;

export function isDevinCatalogModel(id: string): boolean {
  return !OUTSIDE_DEVIN.test(id);
}
