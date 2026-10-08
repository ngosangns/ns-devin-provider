// Public surface of the host-neutral Devin (Cascade) core.

export {
  assignDevinModel,
  DEVIN_ASSIGN_MODEL_PATH,
  DEVIN_AUTH_PATH,
  DEVIN_CHAT_MESSAGE_PATH,
  DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
  DEVIN_GET_USER_STATUS_PATH,
  type DevinAuthMetadata,
  devinUnaryHeaders,
  type FetchImpl,
  fetchDevinAuthMetadata,
  postDevinUnary,
} from "./client.js";
export {
  CONNECT_COMPRESSED_FLAG,
  CONNECT_END_STREAM_FLAG,
  type ConnectEnvelope,
  ConnectFrameReader,
  encodeConnectFrame,
  MAX_CONNECT_FRAME_PAYLOAD,
} from "./connect.js";
export {
  type DevinStoredCredentials,
  devinCredentialsPath,
  resolveDevinCredentials,
  resolveDevinSession,
  saveDevinCredentials,
} from "./credentials.js";
export {
  type DevinModelDiscoveryOptions,
  fetchDevinModels,
  normalizeDevinModels,
} from "./discovery.js";
export {
  type ConnectTrailerError,
  createDevinHttpError,
  DevinApiError,
  DevinProtocolError,
  DevinStreamError,
  isDevinAuthError,
  isDevinCapacityError,
  isDevinContextOverflowError,
  isDevinRateLimitError,
  parseRetryAfterMs,
  readConnectTrailerError,
} from "./errors.js";
export {
  INVALID_ARGUMENTS_RAW_LIMIT,
  parseStreamingJson,
  parseStreamingJsonThrottled,
  parseToolCallArguments,
  STREAMING_JSON_PARSE_MIN_GROWTH,
} from "./json.js";
export {
  DEVIN_MODEL_IDS,
  devinModelCachePath,
  devinModels,
  getCachedModels,
  isCacheStale,
  resolveDevinModel,
  updateDevinModelsCache,
} from "./models.js";
export {
  credentialsFromToken,
  type DevinAuthMethod,
  type DevinCredentials,
  type DevinLoginCallbacks,
  exchangeDevinCliToken,
  isDevinApiKey,
  isExpired,
  loginDevinWithPkce,
  refreshDevinToken,
} from "./oauth.js";
export * as devinProto from "./proto/devin-messages.js";
export {
  create,
  fromBinary,
  type InferMessage,
  type JsonValue,
  type MessageCodec,
  type ProtoMessage,
  toBinary,
  toJson,
} from "./proto/protobuf.js";
export { decodeDevinUnaryMessage } from "./proto/wire-helpers.js";
export {
  buildChatMessagePrompts,
  buildDevinChatRequest,
  buildRouterPrompt,
  buildUserPrompt,
  DEVIN_DEFAULT_STOP_PATTERNS,
  type DevinChatOptions,
  type DevinTurn,
  resolveChatModelUid,
} from "./request-builder.js";
export { isGeminiRoutedModel, normalizeSchemaForGoogle } from "./schema.js";
export {
  calculateDevinCost,
  type DevinStreamRequest,
  LARGE_HISTORY_RECOVERY_BYTES,
  streamDevin,
} from "./stream.js";
export * from "./types.js";
export {
  buildDevinUsageReport,
  type DevinProviderUsage,
  type DevinUsageFetchOptions,
  type DevinUsageLimit,
  type DevinUsageUnit,
  type DevinUsageWindowId,
  fetchDevinUsage,
} from "./usage.js";
export {
  type DeterministicUuid,
  type DevinLogger,
  deterministicUuid,
  isRecord,
  logger,
  normalizeSystemPrompts,
  redactSensitiveCredentials,
  sanitizeText,
} from "./util.js";
export {
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_MANAGEMENT_BASE_URL,
  DEVIN_SESSION_TOKEN_PREFIX,
  DEVIN_WEBAPP_URL,
  devinCliMetadata,
  devinDiscoveryMetadata,
  devinWireMetadata,
  normalizeDevinSessionToken,
} from "./wire.js";
