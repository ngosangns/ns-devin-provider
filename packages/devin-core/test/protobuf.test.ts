import { describe, expect, it } from "vitest";
import {
  ChatMessagePromptSchema,
  ChatMessageSource,
  ChatToolCallSchema,
  GetChatMessageResponseSchema,
  ImageDataSchema,
  MetadataSchema,
  StopReason,
} from "../src/proto/devin-messages.js";
import { create, fromBinary, toBinary } from "../src/proto/protobuf.js";

describe("protobuf codec", () => {
  it("round-trips Metadata including the repeated supportedModelDisplays", () => {
    const metadata = create(MetadataSchema, {
      apiKey: "devin-session-token$tok",
      ideName: "devin-cli",
      ideType: "chisel",
      supportedModelDisplays: [0, 3],
    });
    const decoded = fromBinary(MetadataSchema, toBinary(MetadataSchema, metadata));
    expect(decoded.apiKey).toBe("devin-session-token$tok");
    expect(decoded.ideName).toBe("devin-cli");
    expect(decoded.ideType).toBe("chisel");
    expect(decoded.supportedModelDisplays).toEqual([0, 3]);
  });

  it("round-trips a ChatMessagePrompt with tool calls and images", () => {
    const original = create(ChatMessagePromptSchema, {
      messageId: "m-2",
      source: ChatMessageSource.SYSTEM,
      prompt: "answer",
      thinking: "hmm",
      signature: "sig",
      toolCalls: [create(ChatToolCallSchema, { id: "call_1", name: "read", argumentsJson: '{"p":"x"}' })],
      images: [create(ImageDataSchema, { base64Data: "aGk=", mimeType: "image/png" })],
    });
    const decoded = fromBinary(ChatMessagePromptSchema, toBinary(ChatMessagePromptSchema, original));
    expect(decoded.prompt).toBe("answer");
    expect(decoded.thinking).toBe("hmm");
    expect(decoded.toolCalls).toHaveLength(1);
    expect(decoded.toolCalls[0].argumentsJson).toBe('{"p":"x"}');
    expect(decoded.images[0].mimeType).toBe("image/png");
  });

  it("decodes a GetChatMessageResponse with a stop reason", () => {
    const original = create(GetChatMessageResponseSchema, {
      messageId: "resp-1",
      deltaText: "hi",
      stopReason: StopReason.STOP_PATTERN,
    });
    const decoded = fromBinary(GetChatMessageResponseSchema, toBinary(GetChatMessageResponseSchema, original));
    expect(decoded.messageId).toBe("resp-1");
    expect(decoded.deltaText).toBe("hi");
    expect(decoded.stopReason).toBe(StopReason.STOP_PATTERN);
  });
});
