import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CONNECT_END_STREAM_FLAG } from "../src/connect.js";
import { DevinApiError, DevinStreamError } from "../src/errors.js";
import {
  ChatToolCallSchema,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  GetUserJwtRequestSchema,
  GetUserJwtResponseSchema,
  ModelUsageStatsSchema,
  StopReason,
} from "../src/proto/devin-messages.js";
import { create, fromBinary, toBinary } from "../src/proto/protobuf.js";
import { type DevinStreamRequest, streamDevin } from "../src/stream.js";
import type { DevinStreamEvent } from "../src/types.js";

const model: DevinStreamRequest["model"] = {
  id: "swe-1-6",
  name: "SWE-1.6",
  reasoning: true,
  input: ["text"],
  cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 128_000,
};

function frame(payload: Uint8Array, flag = 0): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flag;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

/** Concatenate Connect frames into one streaming response body. */
function streamBody(...frames: Uint8Array[]): ReadableStream<Uint8Array> {
  const total = frames.reduce((sum, f) => sum + f.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const f of frames) {
    body.set(f, offset);
    offset += f.length;
  }
  return new ReadableStream({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
}

function responseMessage(fields: Partial<import("../src/proto/devin-messages.js").GetChatMessageResponse>): Uint8Array {
  return toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, fields));
}

function toolCall(fields: Partial<import("../src/proto/devin-messages.js").ChatToolCall>) {
  return create(ChatToolCallSchema, fields);
}

/** A fetch stub answering GetUserJwt, then streaming the given response frames. */
function fakeFetch(chatFrames: Uint8Array[], chatStatus = 200) {
  const calls: string[] = [];
  const jwt = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt-1" }));
  const impl = (async (input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("GetUserJwt")) {
      return new Response(jwt, { status: 200 });
    }
    return new Response(streamBody(...chatFrames), { status: chatStatus });
  }) as typeof fetch;
  return { impl, calls };
}

async function collect(request: Partial<DevinStreamRequest>, impl: typeof fetch): Promise<DevinStreamEvent[]> {
  const events: DevinStreamEvent[] = [];
  for await (const event of streamDevin({
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    apiKey: "tok",
    fetch: impl,
    ...request,
  })) {
    events.push(event);
  }
  return events;
}

describe("streamDevin", () => {
  it("emits text deltas and a terminal done", async () => {
    const { impl, calls } = fakeFetch([
      frame(responseMessage({ messageId: "r1", deltaText: "Hello" })),
      frame(responseMessage({ deltaText: " world", stopReason: StopReason.STOP_PATTERN })),
      frame(new TextEncoder().encode("{}"), CONNECT_END_STREAM_FLAG),
    ]);
    const events = await collect({}, impl);
    expect(calls[0]).toContain("GetUserJwt");
    expect(calls[1]).toContain("GetChatMessage");
    expect(events[0]).toEqual({ type: "start" });
    expect(events).toContainEqual({ type: "text_start", index: 0 });
    expect(events).toContainEqual({ type: "text_delta", index: 0, delta: "Hello" });
    expect(events).toContainEqual({ type: "text_delta", index: 0, delta: " world" });
    expect(events).toContainEqual({ type: "text_end", index: 0, text: "Hello world" });
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", stopReason: "stop", responseId: "r1" });
  });

  it("emits thinking blocks before text", async () => {
    const { impl } = fakeFetch([
      frame(responseMessage({ deltaThinking: "ponder" })),
      frame(responseMessage({ deltaSignature: "sig", deltaText: "answer" })),
    ]);
    const events = await collect({}, impl);
    expect(events).toContainEqual({ type: "thinking_start", index: 0 });
    expect(events).toContainEqual({ type: "thinking_delta", index: 0, delta: "ponder" });
    expect(events).toContainEqual({ type: "thinking_end", index: 0, thinking: "ponder", signature: "sig" });
    expect(events).toContainEqual({ type: "text_start", index: 1 });
  });

  it("assembles tool calls and reports toolUse", async () => {
    const { impl } = fakeFetch([
      frame(
        responseMessage({
          deltaToolCalls: [
            toolCall({ id: "call_1", name: "read", argumentsJson: '{"path"' }),
            toolCall({ argumentsJson: ':"/a.ts"}' }),
          ],
        }),
      ),
    ]);
    const events = await collect({}, impl);
    expect(events).toContainEqual({ type: "tool_call_start", index: 0, id: "call_1", name: "read" });
    expect(events).toContainEqual({
      type: "tool_call_end",
      index: 0,
      id: "call_1",
      name: "read",
      arguments: { path: "/a.ts" },
      argumentsJson: '{"path":"/a.ts"}',
    });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "toolUse" });
  });

  it("keeps args-only frames (swe-2 style) on the call that opened them", async () => {
    // swe-2 sends id+name once, then streams field-3-only frames, each in its
    // own Connect frame; none of them may open a new call.
    const { impl } = fakeFetch([
      frame(responseMessage({ deltaToolCalls: [toolCall({ id: "call_1", name: "bash", argumentsJson: "" })] })),
      frame(responseMessage({ deltaToolCalls: [toolCall({ argumentsJson: '{"command":' })] })),
      frame(responseMessage({ deltaToolCalls: [toolCall({ argumentsJson: '"ls -la"}' })] })),
      frame(
        responseMessage({ deltaToolCalls: [toolCall({ id: "call_2", name: "read", argumentsJson: '{"path":"a"}' })] }),
      ),
      frame(responseMessage({ stopReason: StopReason.FUNCTION_CALL })),
    ]);
    const events = await collect({}, impl);
    const starts = events.filter((e) => e.type === "tool_call_start");
    expect(starts).toEqual([
      { type: "tool_call_start", index: 0, id: "call_1", name: "bash" },
      { type: "tool_call_start", index: 1, id: "call_2", name: "read" },
    ]);
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(ends).toMatchObject([
      { id: "call_1", name: "bash", arguments: { command: "ls -la" } },
      { id: "call_2", name: "read", arguments: { path: "a" } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "toolUse" });
  });

  it("never runs truncated tool arguments from the auto-closed preview", async () => {
    const { impl } = fakeFetch([
      frame(
        responseMessage({
          deltaToolCalls: [toolCall({ id: "call_1", name: "write", argumentsJson: '{"path":"/a.ts","content":"hal' })],
        }),
      ),
    ]);
    const events = await collect({}, impl);
    const end = events.find((e) => e.type === "tool_call_end");
    expect(end).toMatchObject({ argumentsJson: '{"path":"/a.ts","content":"hal' });
    expect(end && "arguments" in end && end.arguments).toMatchObject({
      __rawJson: '{"path":"/a.ts","content":"hal',
    });
    expect(end && "arguments" in end && end.arguments.path).toBeUndefined();
  });

  it("retries GetUserJwt with the raw key after a 401 and keeps that form for the turn", async () => {
    const authKeys: string[] = [];
    let chatKey: string | undefined;
    const jwt = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt-1" }));
    const impl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("GetUserJwt")) {
        const key = fromBinary(GetUserJwtRequestSchema, init?.body as Uint8Array).metadata?.apiKey ?? "";
        authKeys.push(key);
        return key.startsWith("devin-session-token$")
          ? new Response("unauthenticated", { status: 401 })
          : new Response(jwt, { status: 200 });
      }
      const body = init?.body as Uint8Array;
      chatKey = fromBinary(GetChatMessageRequestSchema, gunzipSync(body.subarray(5))).metadata?.apiKey;
      return new Response(streamBody(frame(responseMessage({ deltaText: "ok" }))), { status: 200 });
    }) as typeof fetch;
    const events = await collect({ apiKey: "sk-ws-legacy" }, impl);
    expect(authKeys).toEqual(["devin-session-token$sk-ws-legacy", "sk-ws-legacy"]);
    expect(chatKey).toBe("sk-ws-legacy");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  });

  it("does not retry a 401 for a key already in session-token form", async () => {
    let authCalls = 0;
    const impl = (async (input: string | URL) => {
      if (String(input).endsWith("GetUserJwt")) authCalls++;
      return new Response("unauthenticated", { status: 401 });
    }) as typeof fetch;
    await expect(collect({ apiKey: "devin-session-token$abc" }, impl)).rejects.toThrow(DevinApiError);
    expect(authCalls).toBe(1);
  });

  it("maps MAX_TOKENS to a length stop", async () => {
    const { impl } = fakeFetch([frame(responseMessage({ deltaText: "x", stopReason: StopReason.MAX_TOKENS }))]);
    const events = await collect({}, impl);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "length" });
  });

  it("emits usage with computed cost", async () => {
    const usage = create(ModelUsageStatsSchema, {
      inputTokens: 1_000_000n,
      outputTokens: 100_000n,
      cacheReadTokens: 0n,
      cacheWriteTokens: 0n,
    });
    const { impl } = fakeFetch([frame(responseMessage({ usage, creditCost: 3 }))]);
    const events = await collect({}, impl);
    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent).toMatchObject({
      type: "usage",
      usage: { input: 1_000_000, output: 100_000, totalTokens: 1_100_000, credits: 3 },
    });
    // 1M in at $2/M + 0.1M out at $10/M = $3.
    expect(usageEvent && "usage" in usageEvent && usageEvent.usage.cost.total).toBeCloseTo(3);
  });

  it("throws DevinStreamError on a Connect trailer rejection", async () => {
    const { impl } = fakeFetch([
      frame(responseMessage({ deltaText: "partial" })),
      frame(
        new TextEncoder().encode('{"error":{"code":"resource_exhausted","message":"slow down"}}'),
        CONNECT_END_STREAM_FLAG,
      ),
    ]);
    await expect(collect({}, impl)).rejects.toThrow(DevinStreamError);
  });

  it("throws DevinApiError on a non-OK chat response", async () => {
    const { impl } = fakeFetch([], 429);
    await expect(collect({}, impl)).rejects.toThrow(DevinApiError);
  });
});
