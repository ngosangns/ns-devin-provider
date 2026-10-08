// ABOUTME: GetUserStatus credential handling: session-token form first, raw
// ABOUTME: legacy Windsurf key after a 401 (mirrors GetUserJwt).

import { describe, expect, it } from "vitest";
import {
  GetUserStatusRequestSchema,
  GetUserStatusResponseSchema,
  PlanStatusSchema,
  UserStatusSchema,
} from "../src/proto/devin-messages.js";
import { create, fromBinary, toBinary } from "../src/proto/protobuf.js";
import { fetchDevinUsage } from "../src/usage.js";

describe("fetchDevinUsage", () => {
  it("retries a 401 with the raw legacy key", async () => {
    const keys: string[] = [];
    const ok = toBinary(
      GetUserStatusResponseSchema,
      create(GetUserStatusResponseSchema, {
        userStatus: create(UserStatusSchema, { email: "a@b.c", planStatus: create(PlanStatusSchema, {}) }),
      }),
    );
    const impl = (async (_input: string | URL, init?: RequestInit) => {
      const key = fromBinary(GetUserStatusRequestSchema, init?.body as Uint8Array).metadata?.apiKey ?? "";
      keys.push(key);
      return key.startsWith("devin-session-token$")
        ? new Response("unauthenticated", { status: 401 })
        : new Response(ok, { status: 200 });
    }) as typeof fetch;
    const report = await fetchDevinUsage({ apiKey: "sk-ws-legacy", fetch: impl });
    expect(keys).toEqual(["devin-session-token$sk-ws-legacy", "sk-ws-legacy"]);
    expect(report?.email).toBe("a@b.c");
  });
});
