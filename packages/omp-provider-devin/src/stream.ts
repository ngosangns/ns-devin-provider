// ABOUTME: Drives devin-core's neutral event stream into OMP's AssistantMessageEventStream.
// ABOUTME: Owns message assembly; the core owns the wire protocol.

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@oh-my-pi/pi-ai";
import * as PiAi from "@oh-my-pi/pi-ai";
import { type DevinEffort, type DevinModelSpec, getCachedModels, streamDevin } from "ns-devin-core";
import { resolveRequestCredentials } from "./auth.js";
import { toDevinMessages, toDevinTools } from "./messages.js";

/** Message-only error string: an unknown throw should never crash the stream. */
function formatSafeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Catalog metadata this provider attaches to the models it registers. */
export type DevinBackedModel = Model<Api> & {
  requestModelId?: string;
};

/**
 * pi-ai's barrel re-exports the stream class as type-only ahead of the runtime
 * class, so a named import resolves to a type. Read the constructor off the
 * namespace instead, and fall back to the factory omp still ships for older
 * extensions when the class itself is not exported.
 */
function newEventStream(): AssistantMessageEventStream {
  const runtime = PiAi as unknown as {
    AssistantMessageEventStream?: new () => AssistantMessageEventStream;
    createAssistantMessageEventStream?: () => AssistantMessageEventStream;
  };
  if (typeof runtime.AssistantMessageEventStream === "function") return new runtime.AssistantMessageEventStream();
  if (typeof runtime.createAssistantMessageEventStream === "function") {
    return runtime.createAssistantMessageEventStream();
  }
  throw new Error("This omp build exposes no AssistantMessageEventStream; omp-provider-devin needs omp >= 18.1.");
}

const ZERO_USAGE = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/**
 * Rebuild the core's model descriptor from what OMP hands back at request time.
 *
 * OMP's registry keeps its own `Model`, built from the config this provider
 * registered, so the catalog entry is looked up again rather than carried
 * through: the effort map decides the wire uid, and a request must use the
 * same one the catalog advertised.
 */
export function toDevinModel(model: DevinBackedModel, baseUrl: string | undefined): DevinModelSpec {
  const known = getCachedModels().find((candidate) => candidate.id === model.id);
  return {
    ...(known ?? {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      cost: { ...model.cost },
      contextWindow: model.contextWindow ?? 200_000,
      maxTokens: model.maxTokens ?? 64_000,
    }),
    ...(model.requestModelId ? { requestModelId: model.requestModelId } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export function streamDevinForOmp(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = newEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    try {
      const hostKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
      const credentials = await resolveRequestCredentials(hostKey);

      // Core block indexes are monotonic across the whole response, including
      // across an internal retry; OMP's are positions in `output.content`.
      // Keep the translation rather than assuming they agree.
      let indexes = new Map<number, number>();
      const open = (coreIndex: number, block: AssistantMessage["content"][number]): number => {
        const contentIndex = output.content.length;
        output.content.push(block);
        indexes.set(coreIndex, contentIndex);
        return contentIndex;
      };
      const at = (coreIndex: number): number | undefined => indexes.get(coreIndex);

      for await (const event of streamDevin({
        model: toDevinModel(model as DevinBackedModel, credentials.baseUrl ?? model.baseUrl),
        messages: toDevinMessages(context.messages),
        systemPrompt: context.systemPrompt,
        tools: toDevinTools(context.tools),
        effort: options?.reasoning as DevinEffort | undefined,
        apiKey: credentials.apiKey,
        conversationId: options?.sessionId,
        signal: options?.signal,
      })) {
        switch (event.type) {
          case "start":
            stream.push({ type: "start", partial: output });
            break;
          case "reset":
            output.content = [];
            indexes = new Map();
            break;
          case "text_start": {
            const contentIndex = open(event.index, { type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex, partial: output });
            break;
          }
          case "text_delta": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            (output.content[contentIndex] as TextContent).text += event.delta;
            stream.push({ type: "text_delta", contentIndex, delta: event.delta, partial: output });
            break;
          }
          case "text_end": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            (output.content[contentIndex] as TextContent).text = event.text;
            stream.push({ type: "text_end", contentIndex, content: event.text, partial: output });
            break;
          }
          case "thinking_start": {
            const contentIndex = open(event.index, { type: "thinking", thinking: "" });
            stream.push({ type: "thinking_start", contentIndex, partial: output });
            break;
          }
          case "thinking_delta": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            (output.content[contentIndex] as ThinkingContent).thinking += event.delta;
            stream.push({ type: "thinking_delta", contentIndex, delta: event.delta, partial: output });
            break;
          }
          case "thinking_end": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            const block = output.content[contentIndex] as ThinkingContent;
            block.thinking = event.thinking;
            if (event.signature) block.thinkingSignature = event.signature;
            stream.push({ type: "thinking_end", contentIndex, content: event.thinking, partial: output });
            break;
          }
          case "tool_call_start": {
            const toolCall: ToolCall = { type: "toolCall", id: event.id, name: event.name, arguments: {} };
            const contentIndex = open(event.index, toolCall);
            stream.push({ type: "toolcall_start", contentIndex, partial: output });
            break;
          }
          case "tool_call_delta": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            stream.push({ type: "toolcall_delta", contentIndex, delta: event.argumentsDelta, partial: output });
            break;
          }
          case "tool_call_end": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            const toolCall = output.content[contentIndex] as ToolCall;
            toolCall.arguments = event.arguments;
            stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
            break;
          }
          case "usage": {
            output.usage.input = event.usage.input;
            output.usage.output = event.usage.output;
            output.usage.totalTokens = event.usage.totalTokens;
            output.usage.cacheRead = event.usage.cacheRead ?? 0;
            output.usage.cacheWrite = event.usage.cacheWrite ?? 0;
            output.usage.cost = { ...event.usage.cost };
            // pi-ai's Usage has no credit field; carry it through so a
            // consumer that knows to look still sees the metering frame.
            if (event.usage.credits !== undefined) {
              (output.usage as unknown as Record<string, unknown>).credits = event.usage.credits;
            }
            break;
          }
          case "done":
            output.stopReason = event.stopReason;
            if (event.errorMessage) output.errorMessage = event.errorMessage;
            // Cascade's own message id for the turn; a replayed history
            // references it so the server threads follow-up turns correctly.
            if (event.responseId) output.responseId = event.responseId;
            if (event.upstreamModel) output.upstreamModel = event.upstreamModel;
            stream.push({ type: "done", reason: event.stopReason, message: output });
            break;
        }
      }
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatSafeError(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })().catch(() => {
    // Safety net: catch any rejection that escapes the inner try/catch (an
    // AbortError during signal teardown, say). Without this the fire-and-forget
    // IIFE produces an unhandled rejection that crashes the host.
    try {
      stream.end();
    } catch {}
  });

  return stream;
}
