// ABOUTME: Host-neutral vocabulary shared by every Devin adapter.
// ABOUTME: Keeps the Cascade wire protocol independent of any one agent's message types.

/** User-facing reasoning levels, ordered least to most intensive. */
export type DevinEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const DEVIN_EFFORT_ORDER: readonly DevinEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface DevinTextContent {
  type: "text";
  text: string;
}
export interface DevinImageContent {
  type: "image";
  /** Base64-encoded bytes, without a data-URL prefix. */
  data: string;
  mimeType: string;
}
export interface DevinThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}
export interface DevinToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type DevinUserContent = DevinTextContent | DevinImageContent;
export type DevinAssistantContent = DevinTextContent | DevinThinkingContent | DevinToolCallContent;

/** Why the previous assistant turn stopped; only `length` changes request shaping. */
export type DevinStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface DevinUserMessage {
  role: "user";
  content: DevinUserContent[];
}
export interface DevinAssistantMessage {
  role: "assistant";
  content: DevinAssistantContent[];
  stopReason?: DevinStopReason;
  /** Devin's own message id for this turn, carried so a reply can reference it. */
  responseId?: string;
}
export interface DevinToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: DevinUserContent[];
  isError: boolean;
}

export type DevinMessage = DevinUserMessage | DevinAssistantMessage | DevinToolResultMessage;

/** One tool offered to the model, in JSON-schema form. */
export interface DevinTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface DevinCost {
  /** Cost per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * One model as this provider needs to see it. Hosts carry richer descriptors;
 * an adapter projects theirs onto this before entering the core.
 */
export interface DevinModelSpec {
  /** Local id used for selection and cost attribution — also the Cascade wire uid. */
  id: string;
  name: string;
  reasoning: boolean;
  /** Selectable efforts, least to most intensive. Absent means no effort control. */
  efforts?: readonly DevinEffort[];
  /** Effort to wire chat-model-uid remap for a family that routes effort via model identity. */
  effortMap?: Partial<Record<DevinEffort, string>>;
  input: ("text" | "image")[];
  cost: DevinCost;
  contextWindow: number;
  maxTokens: number;
  /** Wire uid Cascade uses to resolve a server-side router (`AssignModel`) rather than chat directly. */
  isModelRouter?: boolean;
  supportsParallelToolCalls?: boolean;
  /** Cascade API base URL this model is served from. */
  baseUrl?: string;
}

export interface DevinUsage {
  input: number;
  output: number;
  totalTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Credits billed for this turn, when Devin reported one. */
  credits?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/**
 * What the core emits while a response streams. Block indexes are allocated
 * monotonically and never reused, so a consumer that ignores {@link DevinResetEvent}
 * still sees a well-formed, if longer, block sequence.
 */
export type DevinStreamEvent =
  | { type: "start" }
  | { type: "text_start"; index: number }
  | { type: "text_delta"; index: number; delta: string }
  | { type: "text_end"; index: number; text: string }
  | { type: "thinking_start"; index: number }
  | { type: "thinking_delta"; index: number; delta: string }
  | { type: "thinking_end"; index: number; thinking: string; signature?: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; id: string; argumentsDelta: string }
  | { type: "tool_call_end"; index: number; id: string; name: string; arguments: Record<string, unknown> }
  | DevinResetEvent
  | { type: "usage"; usage: DevinUsage }
  | {
      type: "done";
      stopReason: "stop" | "toolUse" | "length";
      errorMessage?: string;
    };

/**
 * An internal retry discarded everything emitted so far. Hosts able to drop
 * already-delivered blocks should; hosts that cannot may ignore this, because
 * the blocks that follow carry fresh indexes.
 */
export interface DevinResetEvent {
  type: "reset";
}
