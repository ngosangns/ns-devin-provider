// ABOUTME: Unary Connect RPCs a turn depends on: GetUserJwt (session → user
// ABOUTME: JWT + optional edge URL) and AssignModel (router uid → concrete uid).

import { createDevinHttpError, DevinProtocolError } from "./errors.js";
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
import { devinCliMetadata } from "./wire.js";

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
  /** Edge URL the account is pinned to, when the server supplies one. */
  baseUrl?: string;
}

/**
 * Exchange the session token for the per-request user JWT. The JWT rides in
 * `Metadata.userJwt` on every later call and the response may pin a custom API
 * server — a self-hosted/VPC edge — which the chat call must then use.
 */
export async function fetchDevinAuthMetadata(
  apiKey: string | undefined,
  baseUrl: string,
  fetchImpl: FetchImpl,
  signal: AbortSignal | undefined,
): Promise<DevinAuthMetadata> {
  const request = create(GetUserJwtRequestSchema, {
    metadata: create(MetadataSchema, devinCliMetadata(apiKey)),
  });
  const decoded = await postDevinUnary(
    baseUrl,
    DEVIN_AUTH_PATH,
    GetUserJwtRequestSchema,
    GetUserJwtResponseSchema,
    request,
    fetchImpl,
    signal,
    "auth",
  );
  if (!decoded?.userJwt) {
    throw new DevinProtocolError("Devin auth error: GetUserJwt returned an empty user JWT", "runtime");
  }
  const customBaseUrl = decoded.customApiServerUrl.trim();
  return { userJwt: decoded.userJwt, ...(customBaseUrl ? { baseUrl: customBaseUrl.replace(/\/+$/, "") } : undefined) };
}

/**
 * Resolve a server-side router (`adaptive`) into the concrete model uid plus
 * the assignment JWT that authorizes it. The router uid is never a legal
 * `chatModelUid`, so a failed assignment must fail the turn rather than fall
 * back to sending the router id to `GetChatMessage`.
 */
export async function assignDevinModel(
  model: DevinModelSpec,
  turn: { apiKey: string | undefined; cascadeId: string },
  routerPrompt: ChatMessagePrompt | undefined,
  baseUrl: string,
  fetchImpl: FetchImpl,
  signal: AbortSignal | undefined,
): Promise<ModelAssignment> {
  const request = create(AssignModelRequestSchema, {
    metadata: create(MetadataSchema, devinCliMetadata(turn.apiKey)),
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
