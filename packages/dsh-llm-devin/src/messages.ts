// ABOUTME: Projects the Harness conversation vocabulary onto the neutral one devin-core reads.
// ABOUTME: One direction only — responses travel back as stream events, not messages.

import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { type ContentBlock, fileHandleText, offloadedImageText, type RequestMessage } from "@deepseek-ai/dsh-llm";
import type { DevinAssistantContent, DevinMessage, DevinUserContent } from "ns-devin-core";

/**
 * Harness images live in the attachment service, so their bytes are read here
 * rather than carried on the block. A store is optional: without one the images
 * are dropped and the rest of the turn still reaches the model, which is the
 * behaviour a text-only deployment wants.
 */
export interface MessageProjectionContext {
  attachments?: AttachmentStore;
  signal?: AbortSignal;
}

/**
 * The dsh 0.1 shape of a tool result: a `tool-result` block inside a
 * user-role message. dsh 0.2 replaced it with a first-class `tool`-role
 * message, but a 0.1 host still sends this, so it is read structurally.
 */
interface LegacyToolResultBlock {
  type: "tool-result";
  toolCallId: string;
  content: readonly ContentBlock[];
  isError?: boolean;
}

function isLegacyToolResult(block: { type: string }): block is LegacyToolResultBlock {
  return block.type === "tool-result";
}

async function userContent(
  blocks: readonly ContentBlock[],
  context: MessageProjectionContext,
): Promise<DevinUserContent[]> {
  const out: DevinUserContent[] = [];
  for (const block of blocks) {
    if (block.type === "text") out.push({ type: "text", text: block.text });
    else if (block.type === "reasoning") out.push({ type: "text", text: block.text });
    else if (block.type === "file") {
      // Files never go to a provider as bytes: the harness projects them to
      // handle text, and a hand-built call that still carries a file block
      // gets the same representation here.
      out.push({
        type: "text",
        text: fileHandleText(block.attachment, context.attachments?.fileHostPath(block.attachment)),
      });
    } else if (block.type === "image") {
      // An offloaded occurrence is a durable decision to send the placeholder
      // naming the image and its read-only path instead of its bytes.
      if (block.offloaded === true) {
        const hostPath = context.attachments?.imageHostPath(block.attachment);
        out.push({
          type: "text",
          text: offloadedImageText(block.attachment, hostPath ? { readonlyPath: hostPath } : undefined),
        });
        continue;
      }
      if (!context.attachments) continue;
      const stored = await context.attachments.readImage(block.attachment, context.signal);
      out.push({
        type: "image",
        data: Buffer.from(stored.data).toString("base64"),
        mimeType: block.attachment.mediaType,
      });
    }
    // `tool-addition` / `tool-removal` belong to developer messages; this route
    // declares no `toolUpdate`, so every request already carries the full tool list.
  }
  return out;
}

/**
 * Flatten one Harness history into the neutral shape.
 *
 * Tool results arrive as `tool`-role messages (dsh 0.2) or as `tool-result`
 * blocks inside a user message (dsh 0.1); both become neutral `toolResult`
 * messages. The system prompt travels as a `system`-role message rather than a
 * request field, so its text is returned separately for the system slot.
 * `developer` messages only record tool additions/removals, which this route
 * does not read in-history (it declares no `toolUpdate`), so they are skipped.
 */
export async function toDevinMessages(
  messages: readonly RequestMessage[],
  context: MessageProjectionContext = {},
): Promise<{ messages: DevinMessage[]; system?: string }> {
  const out: DevinMessage[] = [];
  const systemParts: string[] = [];
  // The Harness correlates a result by call id alone; the call's name is only
  // on the assistant block, so it is remembered here for the result.
  const toolNames = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "system") {
      for (const block of message.content) if (block.type === "text") systemParts.push(block.text);
      continue;
    }

    if (message.role === "developer") continue;

    if (message.role === "assistant") {
      const content: DevinAssistantContent[] = [];
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        else if (block.type === "reasoning") content.push({ type: "thinking", thinking: block.text });
        else if (block.type === "tool-call") {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(block.arguments || "{}") as Record<string, unknown>;
          } catch {
            // A stored call whose arguments no longer parse is still part of
            // the exchange the model must see; sending it with empty arguments
            // keeps the call/result pairing, which dropping would break.
            args = {};
          }
          toolNames.set(block.id, block.name);
          content.push({ type: "toolCall", id: block.id, name: block.name, arguments: args });
        }
      }
      out.push({ role: "assistant", content });
      continue;
    }

    if (message.role === "tool") {
      out.push({
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: toolNames.get(message.toolCallId) ?? "tool",
        content: await userContent(message.content, context),
        isError: message.isError === true,
      });
      continue;
    }

    // user (durable or request-only input)
    const blocks = message.content as readonly (ContentBlock | LegacyToolResultBlock)[];
    const results = blocks.filter(isLegacyToolResult);
    const plain = blocks.filter((block): block is ContentBlock => !isLegacyToolResult(block));
    if (plain.length > 0) out.push({ role: "user", content: await userContent(plain, context) });
    for (const result of results) {
      out.push({
        role: "toolResult",
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? "tool",
        content: await userContent(result.content, context),
        isError: result.isError === true,
      });
    }
  }

  return { messages: out, ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}) };
}
