// ABOUTME: Unary Connect RPCs a turn depends on: GetUserJwt (session → user
// ABOUTME: JWT + optional edge URL) and AssignModel (router uid → concrete uid).

import { createDevinHttpError, DevinApiError, DevinProtocolError } from "./errors.js";
import {
  AssignModelRequestSchema,
  AssignModelResponseSchema,
  type ChatMessagePrompt,
  GetUserJwtRequestSchema,
  GetUserJwtResponseSchema,
  MetadataSchema,
  type ModelAssignment,
} from "./proto/devin-messages.js";
import { create, toBinary } from "./proto/protobuf.js";
import { decodeDevinUnaryMessage } from "./proto/wire-helpers.js";
import type { DevinModelSpec } from "./types.js";
import { devinCliMetadata, devinWireMetadata } from "./wire.js";

export const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
export const DEVIN_ASSIGN_MODEL_PATH = "/exa.api_server_pb.ApiServerService/AssignModel";
export const DEVIN_CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
export const DEVIN_GET_CLI_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
export const DEVIN_GET_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

export type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Headers every unary Cascade POST shares: raw protobuf, Connect v1. */
export function devinUnaryHeaders(): Record<string, string> {
  return {
    "content-type": "application/proto",
    "connect-protocol-version": "1",
    accept: "*/*",
  };
}

/** POST a unary protobuf RPC and decode the (possibly gzipped) response. */
export async function postDevinUnary<TRequest extends object, TResponse>(
  baseUrl: string,
  path: string,
  requestCodec: { encode(value: TRequest): Uint8Array },
  responseCodec: { decode(value: Uint8Array): TResponse },
  request: TRequest,
  fetchImpl: FetchImpl,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<TResponse | null> {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers: devinUnaryHeaders(),
    body: toBinary(requestCodec as never, request as never),
    signal,
  });
  const payload = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) throw createDevinHttpError(operation, response, payload);
  return decodeDevinUnaryMessage(responseCodec as never, payload) as TResponse | null;
}

export interface DevinAuthMetadata {
  userJwt: string;
  /**
   * The credential exactly as the server accepted it on `GetUserJwt`: the
   * session-token form (`devin-session-token$…`) for CLI logins, or the raw key
   * for a legacy Windsurf Enterprise API key. Later calls in the same turn must
   * carry these bytes, not re-derive them.
   */
  apiKey: string;
  /** Edge URL the account is pinned to, when the server supplies one. */
  baseUrl?: string;
}

async function requestDevinUserJwt(
  metadata: Record<string, unknown>,
  baseUrl: string,
  fetchImpl: FetchImpl,
  signal: AbortSignal | undefined,
) {
  return postDevinUnary(
    baseUrl,
    DEVIN_AUTH_PATH,
    GetUserJwtRequestSchema,
    GetUserJwtResponseSchema,
    create(GetUserJwtRequestSchema, { metadata: create(MetadataSchema, metadata) }),
    fetchImpl,
    signal,
    "auth",
  );
}

/**
 * Exchange the credential for the per-request user JWT. The JWT rides in
 * `Metadata.userJwt` on every later call and the response may pin a custom API
 * server — a self-hosted/VPC edge — which the chat call must then use.
 *
 * The credential is first sent as a Devin session token (the scheme prefix
 * added). Legacy Windsurf Enterprise API keys are rejected in that form with a
 * 401, so a 401 retries once with the raw key before failing.
 */
export async function fetchDevinAuthMetadata(
  apiKey: string | undefined,
  baseUrl: string,
  fetchImpl: FetchImpl,
  signal: AbortSignal | undefined,
): Promise<DevinAuthMetadata> {
  const sessionMetadata = devinCliMetadata(apiKey);
  let wireApiKey = sessionMetadata.apiKey as string;
  let decoded: Awaited<ReturnType<typeof requestDevinUserJwt>>;
  try {
    decoded = await requestDevinUserJwt(sessionMetadata, baseUrl, fetchImpl, signal);
  } catch (error) {
    const rawMetadata = devinWireMetadata(apiKey);
    const rawApiKey = rawMetadata.apiKey as string;
    if (!(error instanceof DevinApiError) || error.status !== 401 || !rawApiKey || rawApiKey === wireApiKey) {
      throw error;
    }
    decoded = await requestDevinUserJwt(rawMetadata, baseUrl, fetchImpl, signal);
    wireApiKey = rawApiKey;
  }
  if (!decoded?.userJwt) {
    throw new DevinProtocolError("Devin auth error: GetUserJwt returned an empty user JWT", "runtime");
  }
  const customBaseUrl = decoded.customApiServerUrl.trim();
  return {
    userJwt: decoded.userJwt,
    apiKey: wireApiKey,
    ...(customBaseUrl ? { baseUrl: customBaseUrl.replace(/\/+$/, "") } : undefined),
  };
}

/**
 * Resolve a server-side router (`adaptive`) into the concrete model uid plus
 * the assignment JWT that authorizes it. The router uid is never a legal
 * `chatModelUid`, so a failed assignment must fail the turn rather than fall
 * back to sending the router id to `GetChatMessage`.
 */
export async function assignDevinModel(
  model: DevinModelSpec,
  turn: { apiKey: string; cascadeId: string },
  routerPrompt: ChatMessagePrompt | undefined,
  baseUrl: string,
  fetchImpl: FetchImpl,
  signal: AbortSignal | undefined,
): Promise<ModelAssignment> {
  const request = create(AssignModelRequestSchema, {
    // `turn.apiKey` is already in the form GetUserJwt accepted.
    metadata: create(MetadataSchema, devinWireMetadata(turn.apiKey)),
    modelRouterUid: model.requestModelId ?? model.id,
    cascadeId: turn.cascadeId,
    ...(routerPrompt ? { chatMessagePrompt: routerPrompt } : {}),
  });
  const decoded = await postDevinUnary(
    baseUrl,
    DEVIN_ASSIGN_MODEL_PATH,
    AssignModelRequestSchema,
    AssignModelResponseSchema,
    request,
    fetchImpl,
    signal,
    "AssignModel",
  );
  const assignment = decoded?.assignment;
  if (!assignment?.assignmentJwt || !assignment.modelUid) {
    throw new DevinProtocolError(
      "Devin AssignModel error: response carried no assignment JWT and model uid",
      "runtime",
    );
  }
  return assignment;
}
