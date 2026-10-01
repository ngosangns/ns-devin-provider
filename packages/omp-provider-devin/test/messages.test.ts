// ABOUTME: Tests the projection from OMP's conversation vocabulary onto the neutral one.

import type { Message } from "@oh-my-pi/pi-ai";
import { describe, expect, it } from "vitest";
import { toDevinMessages } from "../src/messages.js";

describe("toDevinMessages", () => {
  it("maps user, assistant, and toolResult roles", () => {
    const out = toDevinMessages([
      { role: "user", content: "hi", timestamp: 0 } as Message,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t", thinkingSignature: "s" },
          { type: "text", text: "answer" },
          { type: "toolCall", id: "c1", name: "read", arguments: { p: "x" } },
        ],
        api: "devin-agent",
        provider: "devin",
        model: "swe-1-6",
        usage: {},
        stopReason: "toolUse",
        timestamp: 0,
      } as unknown as Message,
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "data" }],
        isError: false,
        timestamp: 0,
      } as Message,
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe("user");
    expect(out[1].role).toBe("assistant");
    const assistant = out[1] as { content: { type: string }[] };
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "t", thinkingSignature: "s" });
    expect(assistant.content[2]).toMatchObject({ type: "toolCall", id: "c1", name: "read" });
    expect(out[2]).toMatchObject({ role: "toolResult", toolCallId: "c1", isError: false });
  });

  it("carries a native responseId so the server threads the reply", () => {
    const out = toDevinMessages([
      {
        role: "assistant",
        provider: "devin",
        responseId: "resp-9",
        content: [{ type: "text", text: "x" }],
      } as unknown as Message,
    ]);
    expect(out[0]).toMatchObject({ role: "assistant", responseId: "resp-9" });
  });

  it("drops content kinds with no wire slot instead of inventing text", () => {
    const out = toDevinMessages([
      {
        role: "assistant",
        provider: "devin",
        content: [{ type: "redacted_thinking", data: "…" } as never],
      } as unknown as Message,
    ]);
    expect((out[0] as { content: unknown[] }).content).toHaveLength(0);
  });
});
