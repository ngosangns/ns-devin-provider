// ABOUTME: Maps Devin's failure vocabulary onto the Harness LlmError taxonomy.

import { LlmError } from "@deepseek-ai/dsh-llm";
import {
  DevinApiError,
  isDevinAuthError,
  isDevinCapacityError,
  isDevinContextOverflowError,
  isDevinRateLimitError,
} from "ns-devin-core";

/**
 * Classify a core failure for the Harness.
 *
 * The core throws Devin errors because it serves two hosts with different
 * error types. This is where they become one of the Harness's routing codes —
 * the loop branches on `code`, so a mislabelled failure either retries forever
 * or gives up on something transient.
 */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const cause = error instanceof Error ? error : undefined;
  const message = cause?.message ?? String(error);

  if (cause?.name === "AbortError") return new LlmError(message, "ABORTED", { cause });

  const status = error instanceof DevinApiError ? error.status : undefined;
  const options = { cause, ...(status !== undefined ? { status } : {}) };

  if (isDevinContextOverflowError(error)) return new LlmError(message, "CONTEXT_OVERFLOW", options);
  if (isDevinRateLimitError(error)) return new LlmError(message, "RATE_LIMIT", options);
  if (isDevinCapacityError(error)) return new LlmError(message, "OVERLOADED", options);
  if (isDevinAuthError(error) || message.includes("credentials not set") || message.includes("No Devin session")) {
    return new LlmError(message, "AUTH", options);
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return new LlmError(message, "TIMEOUT", options);
  }
  return new LlmError(message, "PROVIDER_ERROR", options);
}
