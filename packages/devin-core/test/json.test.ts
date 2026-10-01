import { describe, expect, it } from "vitest";
import { parseStreamingJson, parseStreamingJsonThrottled } from "../src/json.js";

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
