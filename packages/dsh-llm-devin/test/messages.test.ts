// ABOUTME: Tests the projection from the Harness conversation vocabulary onto the neutral one.

import type { Message } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";
import { toDevinMessages } from "../src/messages.js";

const message = (input: Partial<Message> & Pick<Message, "role" | "content">): Message =>
  ({ id: "m1", source: { kind: "user" }, ...input }) as Message;

describe("toDevinMessages", () => {
  it("lifts the system role out of the history into the system slot", async () => {
    const out = await toDevinMessages([
      message({ role: "system", content: [{ type: "text", text: "be brief" }] }),
      message({ role: "user", content: [{ type: "text", text: "hi" }] }),
    ]);
    expect(out.system).toBe("be brief");
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe("user");
  });

  it("lifts tool-result blocks out of a user message into their own records", async () => {
    const out = await toDevinMessages([
      message({
        role: "user",
        content: [
          { type: "text", text: "here" },
          { type: "tool-result", toolCallId: "call_1", isError: false, content: [{ type: "text", text: "ok" }] },
        ],
      } as never),
    ]);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0].role).toBe("user");
    expect(out.messages[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      isError: false,
    });
  });

  it("maps assistant reasoning and tool calls", async () => {
    const out = await toDevinMessages([
      message({
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "answer" },
          { type: "tool-call", id: "c1", name: "read", arguments: '{"p":"x"}' },
        ],
      } as never),
    ]);
    expect(out.messages[0].role).toBe("assistant");
    const content = (out.messages[0] as { content: { type: string }[] }).content;
    expect(content[0]).toEqual({ type: "thinking", thinking: "thinking" });
    expect(content[1]).toEqual({ type: "text", text: "answer" });
    expect(content[2]).toMatchObject({ type: "toolCall", id: "c1", name: "read", arguments: { p: "x" } });
  });
});
