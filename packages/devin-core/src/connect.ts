// ABOUTME: Connect protocol framing over HTTP/1.1 — the 5-byte envelope
// ABOUTME: (flags + big-endian length) plus the incremental frame reader.

import { gunzipSync, gzipSync } from "node:zlib";
import { DevinProtocolError } from "./errors.js";

/** Connect streaming frame flag: payload is gzip-compressed. */
export const CONNECT_COMPRESSED_FLAG = 0x01;
/** Connect streaming frame flag: payload is the end-of-stream JSON trailer. */
export const CONNECT_END_STREAM_FLAG = 0x02;

/**
 * Hard upper bound on a single frame payload. The 4-byte length prefix is
 * otherwise attacker-controlled (up to `2**32 - 1`), so a corrupt peer could
 * force the reader to buffer gigabytes before an abort lands.
 */
export const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;

export interface ConnectEnvelope {
  /** Raw flags byte: `0x01` compressed, `0x02` end-of-stream trailer. */
  flag: number;
  /** Decoded payload — gunzipped when the compressed flag was set. */
  payload: Uint8Array;
  /** True for the end-of-stream trailer frame. */
  endStream: boolean;
}

/** gzip + envelope a unary request body the way connect-go sends it. */
export function encodeConnectFrame(message: Uint8Array): Uint8Array {
  const compressed = gzipSync(message);
  const frame = new Uint8Array(5 + compressed.length);
  frame[0] = CONNECT_COMPRESSED_FLAG;
  new DataView(frame.buffer, frame.byteOffset).setUint32(1, compressed.length);
  frame.set(compressed, 5);
  return frame;
}

/**
 * Incremental Connect frame reader over a `ReadableStream<Uint8Array>` body.
 * `push` each reader chunk; `next()` returns decoded envelopes until the
 * buffer runs dry, in which case it returns `null` so the caller reads again.
 */
export class ConnectFrameReader {
  private pending: Uint8Array = new Uint8Array(0);

  /** Append a network chunk to the parse buffer. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (this.pending.length === 0) {
      this.pending = chunk;
      return;
    }
    const merged = new Uint8Array(this.pending.length + chunk.length);
    merged.set(this.pending, 0);
    merged.set(chunk, this.pending.length);
    this.pending = merged;
  }

  /** Decode the next buffered frame, or `null` when more bytes are needed. */
  next(): ConnectEnvelope | null {
    if (this.pending.length < 5) return null;
    const flag = this.pending[0];
    const length = new DataView(this.pending.buffer, this.pending.byteOffset).getUint32(1);
    if (length > MAX_CONNECT_FRAME_PAYLOAD) {
      throw new DevinProtocolError(
        `Devin Connect frame length ${length} exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`,
        "envelope",
      );
    }
    if (this.pending.length < 5 + length) return null;
    const raw = this.pending.subarray(5, 5 + length);
    this.pending = this.pending.subarray(5 + length);
    const payload = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(raw) : raw;
    return { flag, payload, endStream: (flag & CONNECT_END_STREAM_FLAG) !== 0 };
  }
}
