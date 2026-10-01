// ABOUTME: Tests the Devin → Harness LlmError routing codes.

import { DevinApiError, DevinStreamError } from "ns-devin-core";
import { describe, expect, it } from "vitest";
import { toLlmError } from "../src/errors.js";

const apiError = (status: number) => new DevinApiError(`Devin API error ${status}`, "API", status);

describe("toLlmError", () => {
  it("maps HTTP statuses to routing codes", () => {
    expect(toLlmError(apiError(401)).code).toBe("AUTH");
    expect(toLlmError(apiError(429)).code).toBe("RATE_LIMIT");
    expect(toLlmError(apiError(503)).code).toBe("OVERLOADED");
    expect(toLlmError(apiError(500)).code).toBe("PROVIDER_ERROR");
  });

  it("maps trailer-coded failures", () => {
    expect(toLlmError(new DevinStreamError("x", "unauthenticated")).code).toBe("AUTH");
    expect(toLlmError(new DevinStreamError("x", "resource_exhausted")).code).toBe("RATE_LIMIT");
    expect(toLlmError(new DevinStreamError("x", "invalid_argument", true)).code).toBe("CONTEXT_OVERFLOW");
  });

  it("marks aborts and missing sessions", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(toLlmError(abort).code).toBe("ABORTED");
    expect(toLlmError(new Error("No Devin session found")).code).toBe("AUTH");
  });

  it("labels a Grok-route failure with Grok and keeps the server sentence", () => {
    const quota = new DevinStreamError(
      "Devin stream error failed_precondition: Your weekly usage quota has been exhausted. Visit https://app.devin.ai/settings/usage",
      "failed_precondition",
    );
    const error = toLlmError(quota, "Grok");
    expect(error.code).toBe("RATE_LIMIT");
    expect(error.message).toBe(
      "Grok stream error failed_precondition: Your weekly usage quota has been exhausted. Visit https://app.devin.ai/settings/usage",
    );
    expect(toLlmError(quota).message.startsWith("Devin stream error")).toBe(true);
  });
});
