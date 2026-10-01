import { describe, expect, it } from "vitest";
import {
  createDevinHttpError,
  type DevinApiError,
  DevinStreamError,
  isDevinAuthError,
  isDevinCapacityError,
  isDevinContextOverflowError,
  isDevinRateLimitError,
  readConnectTrailerError,
} from "../src/errors.js";

function httpError(status: number, body: string): DevinApiError {
  return createDevinHttpError(
    "API",
    new Response(body, { status, headers: { "content-type": "application/json" } }),
    new TextEncoder().encode(body),
  );
}

describe("readConnectTrailerError", () => {
  it("extracts code and message from a Connect trailer", () => {
    const trailer = readConnectTrailerError('{"error":{"code":"invalid_argument","message":"bad"}}');
    expect(trailer?.code).toBe("invalid_argument");
    expect(trailer?.message).toBe("bad");
    expect(trailer?.formatted).toBe("Devin stream error invalid_argument: bad");
  });

  it("returns null for a non-error trailer", () => {
    expect(readConnectTrailerError("{}")).toBeNull();
    expect(readConnectTrailerError("not json")).toBeNull();
    expect(readConnectTrailerError("")).toBeNull();
  });

  it("summarizes details into the formatted message", () => {
    const trailer = readConnectTrailerError(
      JSON.stringify({ error: { code: "x", message: "m", details: [{ type: "t", debug: "d" }] } }),
    );
    expect(trailer?.detail).toBe("t: d");
    expect(trailer?.formatted).toContain("[details: t: d]");
  });
});

describe("createDevinHttpError", () => {
  it("extracts the JSON error message from a proto-JSON error body", () => {
    const error = httpError(403, '{"error":{"message":"nope"}}');
    expect(error.status).toBe(403);
    expect(error.message).toContain("nope");
  });

  it("suppresses HTML error bodies", () => {
    const error = createDevinHttpError(
      "API",
      new Response("<!doctype html><html>x</html>", { status: 502, headers: { "content-type": "text/html" } }),
      new TextEncoder().encode("<!doctype html><html>x</html>"),
    );
    expect(error.message).toBe("Devin API error 502");
  });
});

describe("error classification", () => {
  it("routes auth, rate limit, capacity, and overflow", () => {
    expect(isDevinAuthError(httpError(401, ""))).toBe(true);
    expect(isDevinAuthError(httpError(403, ""))).toBe(true);
    expect(isDevinRateLimitError(httpError(429, ""))).toBe(true);
    expect(isDevinCapacityError(httpError(503, ""))).toBe(true);
    expect(isDevinAuthError(new DevinStreamError("x", "unauthenticated"))).toBe(true);
    expect(isDevinRateLimitError(new DevinStreamError("x", "resource_exhausted"))).toBe(true);
    expect(isDevinContextOverflowError(new DevinStreamError("x", "invalid_argument", true))).toBe(true);
    expect(isDevinContextOverflowError(new DevinStreamError("x", "invalid_argument", false))).toBe(false);
  });
});
