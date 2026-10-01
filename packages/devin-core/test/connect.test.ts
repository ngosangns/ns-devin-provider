import { describe, expect, it } from "vitest";
import {
  CONNECT_COMPRESSED_FLAG,
  CONNECT_END_STREAM_FLAG,
  ConnectFrameReader,
  encodeConnectFrame,
  MAX_CONNECT_FRAME_PAYLOAD,
} from "../src/connect.js";
import { DevinProtocolError } from "../src/errors.js";

describe("ConnectFrameReader", () => {
  it("decodes a plain frame", () => {
    const payload = new TextEncoder().encode("hello");
    const frame = new Uint8Array(5 + payload.length);
    new DataView(frame.buffer).setUint32(1, payload.length);
    frame.set(payload, 5);
    const reader = new ConnectFrameReader();
    reader.push(frame);
    const envelope = reader.next();
    expect(envelope?.endStream).toBe(false);
    expect(new TextDecoder().decode(envelope?.payload)).toBe("hello");
    expect(reader.next()).toBeNull();
  });

  it("decodes a gzipped frame produced by encodeConnectFrame", () => {
    const reader = new ConnectFrameReader();
    reader.push(encodeConnectFrame(new TextEncoder().encode("data")));
    const envelope = reader.next();
    expect(envelope?.flag).toBe(CONNECT_COMPRESSED_FLAG);
    expect(new TextDecoder().decode(envelope?.payload ?? new Uint8Array())).toBe("data");
  });

  it("reassembles a frame split across chunks", () => {
    const payload = new TextEncoder().encode("split me");
    const frame = new Uint8Array(5 + payload.length);
    new DataView(frame.buffer).setUint32(1, payload.length);
    frame.set(payload, 5);
    const reader = new ConnectFrameReader();
    reader.push(frame.subarray(0, 3));
    expect(reader.next()).toBeNull();
    reader.push(frame.subarray(3));
    expect(new TextDecoder().decode(reader.next()?.payload ?? new Uint8Array())).toBe("split me");
  });

  it("flags the end-of-stream trailer frame", () => {
    const trailer = new TextEncoder().encode('{"error":{"code":"x"}}');
    const frame = new Uint8Array(5 + trailer.length);
    frame[0] = CONNECT_END_STREAM_FLAG;
    new DataView(frame.buffer).setUint32(1, trailer.length);
    frame.set(trailer, 5);
    const reader = new ConnectFrameReader();
    reader.push(frame);
    expect(reader.next()?.endStream).toBe(true);
  });

  it("rejects a frame length over the cap", () => {
    const frame = new Uint8Array(5);
    new DataView(frame.buffer).setUint32(1, MAX_CONNECT_FRAME_PAYLOAD + 1);
    const reader = new ConnectFrameReader();
    reader.push(frame);
    expect(() => reader.next()).toThrow(DevinProtocolError);
  });
});
