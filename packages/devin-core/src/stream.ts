// ABOUTME: streamDevin — one Cascade turn over Connect server-streaming,
// ABOUTME: emitting the neutral DevinStreamEvent sequence hosts render from.

import { assignDevinModel, DEVIN_CHAT_MESSAGE_PATH, type FetchImpl, fetchDevinAuthMetadata } from "./client.js";
import { ConnectFrameReader, encodeConnectFrame } from "./connect.js";
import { createDevinHttpError, DevinProtocolError, DevinStreamError, readConnectTrailerError } from "./errors.js";
import { parseStreamingJson, parseStreamingJsonThrottled } from "./json.js";
import {
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  type ModelAssignment,
  StopReason,
} from "./proto/devin-messages.js";
import { create, fromBinary, toBinary } from "./proto/protobuf.js";
import {
  buildChatMessagePrompts,
  buildDevinChatRequest,
  buildRouterPrompt,
  type DevinChatOptions,
  type DevinTurn,
} from "./request-builder.js";
import type { DevinEffort, DevinMessage, DevinModelSpec, DevinStreamEvent, DevinTool, DevinUsage } from "./types.js";
import { logger } from "./util.js";
import { DEVIN_DEFAULT_BASE_URL } from "./wire.js";

/**
 * Everything a single Cascade turn needs, in host-neutral terms. Adapters
 * project their conversation/model vocabulary onto this before calling in.
 */
export interface DevinStreamRequest {
  /** The catalog entry the user selected (router specs included). */
  model: DevinModelSpec;
  messages: DevinMessage[];
  systemPrompt?: string | readonly string[];
  tools?: DevinTool[];
  /** Selected reasoning effort; resolves through `model.effortMap`. */
  effort?: DevinEffort;
  /** Devin session token (`devin-session-token$…` or raw — normalized inside). */
  apiKey?: string;
  /** Cascade conversation id; reused so the server threads turns. */
  conversationId?: string;
  /** Falls back to `conversationId` when no `conversationId` is supplied. */
  sessionId?: string;
  signal?: AbortSignal;
  fetch?: FetchImpl;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /** Explicit wire uid; wins over effort routing and the model id. */
  chatModelUid?: string;
}

/**
 * Heuristic bound for the opaque `invalid_argument` trailer Devin raises on a
 * too-large request. Not asserted to be the backend's real limit — it marks
 * the history size at which compaction is worth attempting over a hard fail.
 */
export const LARGE_HISTORY_RECOVERY_BYTES = 512 * 1024;

/** Dollar cost for one turn under the model's per-million-token rate card. */
export function calculateDevinCost(
  cost: DevinModelSpec["cost"],
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): DevinUsage["cost"] {
  const per = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  const input = per(usage.input, cost.input);
  const output = per(usage.output, cost.output);
  const cacheRead = per(usage.cacheRead, cost.cacheRead);
  const cacheWrite = per(usage.cacheWrite, cost.cacheWrite);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/**
 * Stream one Cascade turn as neutral block events.
 *
 * Auth is `GetUserJwt` (session token → user JWT + optional edge URL), then —
 * for router models — `AssignModel`, then `GetChatMessage`. Errors surface as
 * throws: `DevinApiError` on the HTTP envelope, `DevinStreamError` on a Connect
 * trailer rejection, `DevinProtocolError` on malformed wire data.
 */
export async function* streamDevin(request: DevinStreamRequest): AsyncIterable<DevinStreamEvent> {
  const model = request.model;
  const fetchImpl = request.fetch ?? fetch;
  const baseUrl = (model.baseUrl || DEVIN_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const auth = await fetchDevinAuthMetadata(request.apiKey, baseUrl, fetchImpl, request.signal);
  const chatBaseUrl = auth.baseUrl ?? baseUrl;

  const turn: DevinTurn = {
    apiKey: request.apiKey,
    userJwt: auth.userJwt,
    cascadeId: request.conversationId ?? request.sessionId ?? crypto.randomUUID(),
  };

  // Router models (`adaptive`) are not valid chat uids: the server resolves
  // them through AssignModel, which returns the uid plus a JWT the chat
  // request must carry on the same cascade id.
  let upstreamModel: string | undefined;
  let assignment: ModelAssignment | undefined;
  if (model.isModelRouter) {
    assignment = await assignDevinModel(
      model,
      turn,
      buildRouterPrompt(request.messages),
      chatBaseUrl,
      fetchImpl,
      request.signal,
    );
    upstreamModel = assignment.modelUid;
  }

  const options: DevinChatOptions = {
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { topP: request.topP } : {}),
    ...(request.stopSequences !== undefined ? { stopSequences: request.stopSequences } : {}),
    ...(request.chatModelUid !== undefined ? { chatModelUid: request.chatModelUid } : {}),
  };
  const chatRequest = buildDevinChatRequest({
    model,
    messages: request.messages,
    systemPrompt: request.systemPrompt,
    tools: request.tools,
    options,
    turn,
    assignment,
    effort: request.effort,
  });
  const requestBytes = toBinary(GetChatMessageRequestSchema, chatRequest);
  const frame = encodeConnectFrame(requestBytes);
  logger.debug("sending chat request", {
    model: model.id,
    tools: request.tools?.length ?? 0,
    requestBytes: requestBytes.byteLength,
    compressedBytes: frame.byteLength - 5,
  });

  const response = await fetchImpl(chatBaseUrl + DEVIN_CHAT_MESSAGE_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      "connect-content-encoding": "gzip",
      "accept-encoding": "identity",
      "user-agent": "connect-go/1.18.1 (go1.26.3)",
      "connect-accept-encoding": "gzip",
    },
    body: frame,
    signal: request.signal,
  });
  if (!response.ok) {
    throw createDevinHttpError("API", response, new Uint8Array(await response.arrayBuffer()));
  }
  if (!response.body) {
    throw new DevinProtocolError("Devin API error: response body is empty", "empty-body");
  }

  yield { type: "start" };

  // Block indexes are allocated monotonically and never reused, so a host may
  // key rendered blocks on `index` without tracking open/close pairing.
  let nextIndex = 0;
  let sawAnyToken = false;
  let latestStopReason = StopReason.UNSPECIFIED;
  let responseId: string | undefined;
  let responseUsage: DevinUsage | undefined;

  type OpenBlock = { index: number; text: string };
  let openText: OpenBlock | undefined;
  let openThinking: (OpenBlock & { signature?: string }) | undefined;
  const toolBlocks = new Map<string, { index: number; name: string }>();
  const toolPartialJson = new Map<string, string>();
  const toolLastParseLen = new Map<string, number>();
  let activeToolCallId: string | undefined;

  const markToken = () => {
    sawAnyToken = true;
  };

  const reader = new ConnectFrameReader();
  const body = response.body.getReader();
  for (;;) {
    const { done, value } = await body.read();
    if (value && value.length > 0) reader.push(value);

    for (;;) {
      const envelope = reader.next();
      if (envelope === null) break;

      if (envelope.endStream) {
        const trailerError = readConnectTrailerError(new TextDecoder().decode(envelope.payload).trim());
        if (trailerError === null) continue;
        logger.warn("stream rejected via Connect trailer", {
          model: model.id,
          code: trailerError.code,
          message: trailerError.message,
          ...(trailerError.detail ? { detail: trailerError.detail } : {}),
          rawTrailer: trailerError.raw,
          requestBytes: requestBytes.byteLength,
          messages: request.messages.length,
          hadOutput: sawAnyToken,
        });
        let contextOverflow = false;
        if (
          !sawAnyToken &&
          trailerError.code.toLowerCase() === "invalid_argument" &&
          /\binternal error\b/i.test(trailerError.message)
        ) {
          // The full protobuf also carries the system prompt and tool schemas,
          // which history maintenance cannot shrink. Re-encode only the
          // repeated history field before choosing this recovery signal.
          const historyBytes = toBinary(
            GetChatMessageRequestSchema,
            create(GetChatMessageRequestSchema, {
              chatMessagePrompts: buildChatMessagePrompts(request.messages, turn.cascadeId),
            }),
          ).byteLength;
          contextOverflow = historyBytes >= LARGE_HISTORY_RECOVERY_BYTES;
          if (contextOverflow) {
            logger.warn("treating large-history invalid_argument as context overflow", {
              model: model.id,
              historyBytes,
            });
          }
        }
        throw new DevinStreamError(trailerError.formatted, trailerError.code, contextOverflow);
      }

      const msg = fromBinary(GetChatMessageResponseSchema, envelope.payload);
      if (msg.messageId && !responseId) responseId = msg.messageId;
      // The router reports the concrete model it landed on; it can differ
      // from the uid AssignModel handed back (fallbacks, capacity routing).
      if (msg.actualModelUid) upstreamModel = msg.actualModelUid;

      if (msg.deltaThinking) {
        markToken();
        if (openThinking === undefined) {
          openThinking = { index: nextIndex++, text: "" };
          yield { type: "thinking_start", index: openThinking.index };
        }
        openThinking.text += msg.deltaThinking;
        yield { type: "thinking_delta", index: openThinking.index, delta: msg.deltaThinking };
      }

      // The signature can land on a frame that carries no thinking delta.
      if (msg.deltaSignature && openThinking !== undefined) openThinking.signature = msg.deltaSignature;

      if (msg.deltaText) {
        markToken();
        if (openThinking !== undefined) {
          yield {
            type: "thinking_end",
            index: openThinking.index,
            thinking: openThinking.text,
            ...(openThinking.signature ? { signature: openThinking.signature } : {}),
          };
          openThinking = undefined;
        }
        if (openText === undefined) {
          openText = { index: nextIndex++, text: "" };
          yield { type: "text_start", index: openText.index };
        }
        openText.text += msg.deltaText;
        yield { type: "text_delta", index: openText.index, delta: msg.deltaText };
      }

      if (msg.deltaToolCalls.length > 0) {
        markToken();
        if (openText !== undefined) {
          yield { type: "text_end", index: openText.index, text: openText.text };
          openText = undefined;
        }
        if (openThinking !== undefined) {
          yield {
            type: "thinking_end",
            index: openThinking.index,
            thinking: openThinking.text,
            ...(openThinking.signature ? { signature: openThinking.signature } : {}),
          };
          openThinking = undefined;
        }
        for (const call of msg.deltaToolCalls) {
          const toolCallId = call.id || activeToolCallId;
          if (!toolCallId) continue;
          let block = toolBlocks.get(toolCallId);
          if (block === undefined) {
            block = { index: nextIndex++, name: call.name };
            toolBlocks.set(toolCallId, block);
            toolPartialJson.set(toolCallId, "");
            yield { type: "tool_call_start", index: block.index, id: toolCallId, name: call.name };
          }
          if (call.name) block.name = call.name;
          activeToolCallId = toolCallId;
          if (!call.argumentsJson) continue;
          const previousJson = toolPartialJson.get(toolCallId) ?? "";
          // The server may send cumulative JSON instead of deltas; merge
          // whichever representation arrived into one delta stream.
          const accumulated = call.argumentsJson.startsWith(previousJson)
            ? call.argumentsJson
            : previousJson + call.argumentsJson;
          const delta = accumulated.slice(previousJson.length);
          toolPartialJson.set(toolCallId, accumulated);
          const throttled = parseStreamingJsonThrottled(accumulated, toolLastParseLen.get(toolCallId) ?? 0);
          if (throttled) toolLastParseLen.set(toolCallId, throttled.parsedLen);
          yield { type: "tool_call_delta", index: block.index, id: toolCallId, argumentsDelta: delta };
        }
      }

      if (msg.stopReason !== StopReason.UNSPECIFIED) latestStopReason = msg.stopReason;

      if (msg.usage || msg.creditCost || msg.committedCreditCost || msg.committedAcuCost) {
        const usage = {
          input: Number(msg.usage?.inputTokens ?? 0n),
          output: Number(msg.usage?.outputTokens ?? 0n),
          cacheRead: Number(msg.usage?.cacheReadTokens ?? 0n),
          cacheWrite: Number(msg.usage?.cacheWriteTokens ?? 0n),
        };
        const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        // The backend stamps a usage field on every frame; only a counter that
        // moved is worth an event — all-zero frames are per-token noise.
        const credits = msg.creditCost || msg.committedCreditCost || msg.committedAcuCost;
        const moved =
          responseUsage === undefined
            ? totalTokens > 0 || credits !== 0
            : totalTokens !== responseUsage.totalTokens || credits !== responseUsage.credits;
        if (!moved) continue;
        responseUsage = {
          ...usage,
          totalTokens,
          ...(credits ? { credits } : {}),
          cost: calculateDevinCost(model.cost, usage),
        };
        yield { type: "usage", usage: responseUsage };
      }
    }

    if (done) break;
  }

  if (openText !== undefined) {
    yield { type: "text_end", index: openText.index, text: openText.text };
  }
  if (openThinking !== undefined) {
    yield {
      type: "thinking_end",
      index: openThinking.index,
      thinking: openThinking.text,
      ...(openThinking.signature ? { signature: openThinking.signature } : {}),
    };
  }
  for (const [id, block] of toolBlocks) {
    yield {
      type: "tool_call_end",
      index: block.index,
      id,
      name: block.name,
      arguments: parseStreamingJson(toolPartialJson.get(id)),
    };
  }

  const stopReason: "stop" | "toolUse" | "length" =
    toolBlocks.size > 0 ? "toolUse" : latestStopReason === StopReason.MAX_TOKENS ? "length" : "stop";
  yield {
    type: "done",
    stopReason,
    ...(responseId ? { responseId } : {}),
    ...(upstreamModel ? { upstreamModel } : {}),
  };
}
