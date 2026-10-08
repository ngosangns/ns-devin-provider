// ABOUTME: Map the neutral DevinMessage history onto Cascade's
// ABOUTME: ChatMessagePrompt wire shape and assemble GetChatMessageRequest.

import {
  CacheControlType,
  type ChatMessagePrompt,
  ChatMessagePromptSchema,
  ChatMessageRequestType,
  ChatMessageSource,
  ChatToolCallSchema,
  ChatToolChoiceSchema,
  ChatToolDefinitionSchema,
  CompletionConfigurationSchema,
  ConversationalPlannerMode,
  type GetChatMessageRequest,
  GetChatMessageRequestSchema,
  ImageDataSchema,
  MetadataSchema,
  type ModelAssignment,
  PromptCacheOptionsSchema,
} from "./proto/devin-messages.js";
import { create } from "./proto/protobuf.js";
import { isGeminiRoutedModel, normalizeSchemaForGoogle } from "./schema.js";
import type { DevinEffort, DevinMessage, DevinModelSpec, DevinTool, DevinUserMessage } from "./types.js";
import { deterministicUuid, normalizeSystemPrompts } from "./util.js";
import { devinWireMetadata } from "./wire.js";

export const DEVIN_DEFAULT_STOP_PATTERNS = [
  "<|user|>",
  "<|bot|>",
  "<|context_request|>",
  "<|endoftext|>",
  "<|end_of_turn|>",
];

/** Per-turn wire state shared by `AssignModel` and `GetChatMessage`. */
export interface DevinTurn {
  /** Credential bytes exactly as `GetUserJwt` accepted them (see `DevinAuthMetadata.apiKey`). */
  apiKey: string;
  userJwt: string;
  /** Cascade thread id; assignment and chat must agree or the JWT is rejected. */
  cascadeId: string;
}

/** Knobs a host may carry that land on `CompletionConfiguration` / the request. */
export interface DevinChatOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /** Wire uid selected after thinking-effort routing; wins over the model id. */
  chatModelUid?: string;
}

/** Resolve the wire uid for one turn: effort → family lane → model id. */
export function resolveChatModelUid(model: DevinModelSpec, effort: DevinEffort | undefined, override?: string): string {
  if (override) return override;
  if (effort && model.effortMap?.[effort]) return model.effortMap[effort];
  return model.requestModelId ?? model.id;
}

/** Flatten one user turn into a Cascade USER prompt with inline images. */
export function buildUserPrompt(msg: DevinUserMessage, messageId: string): ChatMessagePrompt {
  let prompt = "";
  const images = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      prompt += part.text;
    } else if (part.type === "image") {
      images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
    }
  }
  return create(ChatMessagePromptSchema, { messageId, source: ChatMessageSource.USER, prompt, images });
}

/**
 * The prompt the router scores: the current user turn on its own. Native
 * leaves `messageId` empty — the turn's id is minted by the chat request.
 */
export function buildRouterPrompt(messages: DevinMessage[]): ChatMessagePrompt | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const msg = messages[index];
    if (msg.role === "user") return buildUserPrompt(msg, "");
  }
  return undefined;
}

/**
 * Map the neutral history onto Cascade `ChatMessagePrompt`s (USER / SYSTEM /
 * TOOL channels). `messageId` seeds are `cascadeId\0index\0role[...]` — prompt
 * text is excluded so ids stay stable across content edits/history rebuilds.
 */
export function buildChatMessagePrompts(messages: DevinMessage[], cascadeId: string): ChatMessagePrompt[] {
  const prompts: ChatMessagePrompt[] = [];
  for (const [index, msg] of messages.entries()) {
    if (msg.role === "user") {
      prompts.push(buildUserPrompt(msg, deterministicUuid(`${cascadeId}\0${index}\0${msg.role}`)));
      continue;
    }
    if (msg.role === "assistant") {
      // A turn Devin produced carries its own message id — reuse it so the
      // server threads the reply onto the same wire record.
      const isNative = msg.responseId !== undefined && msg.responseId !== "";
      let promptText = "";
      let thinkingText = "";
      let signature = "";
      const toolCalls = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          promptText += part.text;
        } else if (part.type === "thinking") {
          thinkingText += part.thinking;
          if (isNative && !signature && part.thinkingSignature) signature = part.thinkingSignature;
        } else if (part.type === "toolCall") {
          toolCalls.push(
            create(ChatToolCallSchema, {
              id: part.id,
              name: part.name,
              argumentsJson: JSON.stringify(part.arguments),
            }),
          );
        }
      }
      if (!promptText && !thinkingText && !signature && toolCalls.length === 0) continue;
      prompts.push(
        create(ChatMessagePromptSchema, {
          messageId:
            isNative && msg.responseId
              ? msg.responseId
              : `bot-${deterministicUuid(`${cascadeId}\0${index}\0assistant`)}`,
          source: ChatMessageSource.SYSTEM,
          prompt: promptText,
          thinking: thinkingText,
          signature,
          signatureType: "",
          toolCalls,
        }),
      );
      continue;
    }
    // toolResult
    let resultText = "";
    const images = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        resultText += part.text;
      } else if (part.type === "image") {
        images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
      }
    }
    prompts.push(
      create(ChatMessagePromptSchema, {
        messageId: deterministicUuid(`${cascadeId}\0${index}\0tool\0${msg.toolCallId}`),
        source: ChatMessageSource.TOOL,
        toolCallId: msg.toolCallId,
        toolResultIsError: msg.isError,
        prompt: resultText,
        images,
      }),
    );
  }
  return prompts;
}

/**
 * Build a {@link GetChatMessageRequest} for one Cascade turn. Auth rides inside
 * `Metadata.apiKey`/`userJwt`; `assignment` is present only for router models
 * and supplies both the resolved uid and its JWT.
 */
export function buildDevinChatRequest(params: {
  model: DevinModelSpec;
  messages: DevinMessage[];
  systemPrompt?: string | readonly string[];
  tools?: DevinTool[];
  options?: DevinChatOptions;
  turn: DevinTurn;
  assignment?: ModelAssignment;
  effort?: DevinEffort;
}): GetChatMessageRequest {
  const { model, messages, tools, turn, assignment } = params;
  const options = params.options ?? {};
  const stopPatterns =
    options.stopSequences && options.stopSequences.length > 0
      ? [...DEVIN_DEFAULT_STOP_PATTERNS, ...options.stopSequences]
      : DEVIN_DEFAULT_STOP_PATTERNS;
  const chatModelUid = assignment?.modelUid ?? resolveChatModelUid(model, params.effort, options.chatModelUid);
  // Devin routes multiple provider families through one Cascade envelope. Its
  // Gemini backend rejects JSON Schema type arrays (`["number","null"]`) as an
  // opaque `invalid_argument`; normalize before serializing tool schemas.
  const googleToolSchema = isGeminiRoutedModel(model.id, model.requestModelId, chatModelUid);
  const wireTools = (model.supportsTools === false ? [] : (tools ?? [])).map((tool) => {
    const schema = structuredClone(tool.parameters) as Record<string, unknown>;
    return create(ChatToolDefinitionSchema, {
      name: tool.name,
      description: tool.description,
      jsonSchemaString: JSON.stringify(googleToolSchema ? normalizeSchemaForGoogle(schema) : schema),
      strict: tool.strict ?? false,
    });
  });
  return create(GetChatMessageRequestSchema, {
    metadata: create(MetadataSchema, devinWireMetadata(turn.apiKey, turn.userJwt)),
    prompt: normalizeSystemPrompts(params.systemPrompt).join("\n\n"),
    chatMessagePrompts: buildChatMessagePrompts(messages, turn.cascadeId),
    chatModelUid,
    ...(assignment ? { modelAssignmentJwt: assignment.assignmentJwt } : {}),
    requestType: ChatMessageRequestType.CASCADE,
    plannerMode: ConversationalPlannerMode.DEFAULT,
    toolChoice: create(ChatToolChoiceSchema, { choice: { case: "optionName", value: "auto" } }),
    systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: CacheControlType.EPHEMERAL }),
    disableParallelToolCalls: model.supportsParallelToolCalls !== true,
    cascadeId: turn.cascadeId,
    executionId: crypto.randomUUID(),
    configuration: create(CompletionConfigurationSchema, {
      numCompletions: 1n,
      maxTokens: BigInt(options.maxTokens ?? model.maxTokens ?? 64000),
      maxNewlines: 200n,
      temperature: options.temperature ?? 0.4,
      firstTemperature: options.temperature ?? 0.4,
      topK: 50n,
      topP: options.topP ?? 1,
      stopPatterns,
      fimEotProbThreshold: 1,
    }),
    tools: wireTools,
  });
}
