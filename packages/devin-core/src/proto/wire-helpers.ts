// ABOUTME: Protobuf decoding helpers for Devin's unary Connect RPCs.
// ABOUTME: Kept separate from wire.ts so that module stays protobuf-free for the boot path.

import { gunzipSync } from "node:zlib";
import { fromBinary, type MessageCodec, type ProtoMessage } from "./protobuf.js";

/**
 * Decode a unary Devin Connect response. Edges variously return bare protobuf
 * or a gzipped protobuf body; the direct decode is attempted before the gzip
 * fallback. Returns `null` when neither representation decodes against `schema`.
 */
export function decodeDevinUnaryMessage<TMessage extends ProtoMessage>(
  schema: MessageCodec<TMessage>,
  payload: Uint8Array,
): TMessage | null {
  try {
    return fromBinary(schema, payload);
  } catch {
    try {
      return fromBinary(schema, gunzipSync(payload));
    } catch {
      return null;
    }
  }
}
