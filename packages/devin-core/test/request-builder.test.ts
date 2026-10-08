import { describe, expect, it } from "vitest";
import { ChatMessageSource, GetChatMessageRequestSchema } from "../src/proto/devin-messages.js";
import { fromBinary, toBinary } from "../src/proto/protobuf.js";
import {
  buildChatMessagePrompts,
  buildDevinChatRequest,
  DEVIN_DEFAULT_STOP_PATTERNS,
  resolveChatModelUid,
} from "../src/request-builder.js";
import type { DevinMessage, DevinModelSpec } from "../src/types.js";

const model: DevinModelSpec = {
  id: "gpt-5-6-sol",
  name: "GPT-5.6 Sol",
  requestModelId: "gpt-5-6-sol-high-uid",
  reasoning: true,
  efforts: ["low", "high"],
  effortMap: { low: "gpt-5-6-sol-low-uid", high: "gpt-5-6-sol-high-uid" },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 64_000,
};

// `turn.apiKey` carries the credential exactly as GetUserJwt accepted it.
const turn = { apiKey: "devin-session-token$tok", userJwt: "jwt", cascadeId: "cascade-1" };

describe("buildChatMessagePrompts", () => {
  it("maps roles onto USER / SYSTEM / TOOL sources", () => {
    const messages: DevinMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
      },
    ];
    const prompts = buildChatMessagePrompts(messages, "cascade-1");
    expect(prompts.map((p) => p.source)).toEqual([
      ChatMessageSource.USER,
      ChatMessageSource.SYSTEM,
      ChatMessageSource.TOOL,
    ]);
    expect(prompts[0].prompt).toBe("hi");
    expect(prompts[1].prompt).toBe("hello");
    expect(prompts[2].toolCallId).toBe("call_1");
    expect(prompts[2].prompt).toBe("contents");
  });

  it("reuses a native responseId as the assistant message id", () => {
    const prompts = buildChatMessagePrompts(
      [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "t", thinkingSignature: "sig" }],
          responseId: "resp-42",
        },
      ],
      "cascade-1",
    );
    expect(prompts[0].messageId).toBe("resp-42");
    expect(prompts[0].signature).toBe("sig");
  });

  it("mints stable deterministic ids for non-native turns", () => {
    const a = buildChatMessagePrompts([{ role: "user", content: [{ type: "text", text: "x" }] }], "c1");
    const b = buildChatMessagePrompts([{ role: "user", content: [{ type: "text", text: "x" }] }], "c1");
    expect(a[0].messageId).toBe(b[0].messageId);
    expect(a[0].messageId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("resolveChatModelUid", () => {
  it("routes effort through the family map", () => {
    expect(resolveChatModelUid(model, "high")).toBe("gpt-5-6-sol-high-uid");
    expect(resolveChatModelUid(model, "low")).toBe("gpt-5-6-sol-low-uid");
  });

  it("falls back to requestModelId then id", () => {
    expect(resolveChatModelUid(model, undefined)).toBe("gpt-5-6-sol-high-uid");
    expect(resolveChatModelUid({ ...model, requestModelId: undefined }, undefined)).toBe("gpt-5-6-sol");
  });
});

describe("buildDevinChatRequest", () => {
  it("produces a request that round-trips through the wire codec", () => {
    const request = buildDevinChatRequest({
      model,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      systemPrompt: "be brief",
      turn,
      effort: "low",
    });
    const decoded = fromBinary(GetChatMessageRequestSchema, toBinary(GetChatMessageRequestSchema, request));
    expect(decoded.prompt).toBe("be brief");
    expect(decoded.chatModelUid).toBe("gpt-5-6-sol-low-uid");
    expect(decoded.cascadeId).toBe("cascade-1");
    expect(decoded.metadata?.apiKey).toBe("devin-session-token$tok");
    expect(decoded.metadata?.userJwt).toBe("jwt");
    expect(decoded.configuration?.stopPatterns).toEqual(DEVIN_DEFAULT_STOP_PATTERNS);
    expect(decoded.toolChoice?.choice).toEqual({ case: "optionName", value: "auto" });
  });

  it("carries the assignment JWT for a router model", () => {
    const request = buildDevinChatRequest({
      model: { ...model, isModelRouter: true },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      turn,
      assignment: { assignmentJwt: "ajwt", modelUid: "real-uid", harnessUids: [] },
    });
    expect(request.modelAssignmentJwt).toBe("ajwt");
    expect(request.chatModelUid).toBe("real-uid");
  });

  it("normalizes type-array tool schemas for a Gemini-routed model", () => {
    const request = buildDevinChatRequest({
      model: { ...model, id: "gemini-3-pro", requestModelId: "MODEL_GOOGLE_GEMINI_3_PRO" },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      turn,
      tools: [
        {
          name: "t",
          description: "d",
          parameters: {
            type: "object",
            properties: { n: { type: ["number", "null"] } },
          },
        },
      ],
    });
    const schema = JSON.parse(request.tools[0].jsonSchemaString) as { properties: Record<string, unknown> };
    expect(schema.properties.n).toEqual({ type: "number", nullable: true });
  });
});
