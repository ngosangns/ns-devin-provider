import { describe, expect, it } from "vitest";
import { parseStreamingJson, parseStreamingJsonThrottled, parseToolCallArguments } from "../src/json.js";

describe("parseStreamingJson", () => {
  it("parses complete JSON", () => {
    expect(parseStreamingJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("auto-closes a truncated object", () => {
    expect(parseStreamingJson('{"a":1,"b":{"c":2')).toEqual({ a: 1, b: { c: 2 } });
  });

  it("auto-closes a truncated string value", () => {
    expect(parseStreamingJson('{"path":"/src/ind')).toEqual({ path: "/src/ind" });
  });

  it("drops a dangling key whose value never arrived", () => {
    expect(parseStreamingJson('{"a":1,"b":')).toEqual({ a: 1 });
  });

  it("returns {} for empty or unrecoverable input", () => {
    expect(parseStreamingJson("")).toEqual({});
    expect(parseStreamingJson(undefined)).toEqual({});
    expect(parseStreamingJson("not json at all")).toEqual({});
  });
});

describe("parseStreamingJsonThrottled", () => {
  it("skips re-parsing until the buffer grows enough", () => {
    expect(parseStreamingJsonThrottled('{"a":1}', 0, 4)).not.toBeNull();
    expect(parseStreamingJsonThrottled('{"a":12}', 7, 4)).toBeNull();
    expect(parseStreamingJsonThrottled('{"a":12345678}', 7, 4)).not.toBeNull();
  });
});

describe("parseToolCallArguments", () => {
  it("parses complete JSON objects and maps empty input to {}", () => {
    expect(parseToolCallArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolCallArguments("")).toEqual({});
    expect(parseToolCallArguments("   ")).toEqual({});
  });

  it("returns a diagnostic, never auto-closed keys, for truncated or trailing JSON", () => {
    expect(parseToolCallArguments('{"path":"/a","content":"x')).toMatchObject({
      __rawJson: '{"path":"/a","content":"x',
    });
    expect(parseToolCallArguments('{"a":1} trailing')).toHaveProperty("__parseError");
    expect(parseToolCallArguments("[1,2]")).toHaveProperty("__parseError");
  });

  it("bounds the raw text kept in the diagnostic", () => {
    const raw = `{"content":"${"x".repeat(2_000)}`;
    const out = parseToolCallArguments(raw) as { __rawJson: string };
    expect(out.__rawJson.length).toBeLessThan(600);
    expect(out.__rawJson).toMatch(/\[truncated \d+ chars\]$/);
  });
});
