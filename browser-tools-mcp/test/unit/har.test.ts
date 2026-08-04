import { describe, it, expect } from "vitest";
import { buildHar } from "../../src/util/har";
import type { NetworkEntry } from "../../src/connector/store";

const entry = (over: Partial<NetworkEntry> = {}): NetworkEntry => ({
  type: "network-request",
  url: "https://api.example.com/users?page=2",
  method: "GET",
  status: 200,
  timestamp: Date.parse("2026-08-04T10:00:00.000Z"),
  durationMs: 123,
  ...over,
});

describe("buildHar", () => {
  it("produces a HAR 1.2 log with a creator", () => {
    const har = buildHar([entry()]) as any;

    expect(har.log.version).toBe("1.2");
    expect(har.log.creator.name).toContain("BrowserTools");
    expect(har.log.creator.version).toBeTruthy();
    expect(Array.isArray(har.log.entries)).toBe(true);
  });

  it("maps the request and response basics", () => {
    const har = buildHar([entry({ method: "POST", status: 503 })]) as any;
    const first = har.log.entries[0];

    expect(first.request.method).toBe("POST");
    expect(first.request.url).toBe("https://api.example.com/users?page=2");
    expect(first.response.status).toBe(503);
    expect(first.startedDateTime).toBe("2026-08-04T10:00:00.000Z");
  });

  it("splits the query string out, as the format expects", () => {
    const har = buildHar([entry()]) as any;
    expect(har.log.entries[0].request.queryString).toEqual([{ name: "page", value: "2" }]);
  });

  it("keeps timings consistent with the total time", () => {
    const har = buildHar([entry({ durationMs: 250 })]) as any;
    const { time, timings } = har.log.entries[0];

    expect(time).toBe(250);
    expect(timings.send + timings.wait + timings.receive).toBe(250);
  });

  it("includes headers when they were captured", () => {
    const har = buildHar([
      entry({
        requestHeaders: { Accept: "application/json" },
        responseHeaders: { "Content-Type": "application/json" },
      }),
    ]) as any;

    expect(har.log.entries[0].request.headers).toEqual([
      { name: "Accept", value: "application/json" },
    ]);
    expect(har.log.entries[0].response.headers).toEqual([
      { name: "Content-Type", value: "application/json" },
    ]);
  });

  it("emits empty header arrays rather than omitting them", () => {
    // A HAR consumer expects the arrays to exist.
    const har = buildHar([entry()]) as any;
    expect(har.log.entries[0].request.headers).toEqual([]);
    expect(har.log.entries[0].response.headers).toEqual([]);
  });

  it("carries response bodies into content", () => {
    const har = buildHar([
      entry({ responseBody: '{"ok":true}', responseHeaders: { "Content-Type": "application/json" } }),
    ]) as any;

    const content = har.log.entries[0].response.content;
    expect(content.text).toBe('{"ok":true}');
    expect(content.mimeType).toBe("application/json");
    expect(content.size).toBe('{"ok":true}'.length);
  });

  it("carries request bodies into postData", () => {
    const har = buildHar([entry({ method: "POST", requestBody: "a=1" })]) as any;
    expect(har.log.entries[0].request.postData.text).toBe("a=1");
  });

  it("does not invent a body where none was captured", () => {
    const har = buildHar([entry()]) as any;
    expect(har.log.entries[0].request.postData).toBeUndefined();
    expect(har.log.entries[0].response.content.size).toBe(0);
  });

  it("passes redacted values through untouched", () => {
    // Redaction happens on ingest; the HAR must not undo or re-apply it.
    const har = buildHar([
      entry({ requestHeaders: { Authorization: "[REDACTED]" } }),
    ]) as any;
    expect(har.log.entries[0].request.headers[0].value).toBe("[REDACTED]");
  });

  it("survives entries with missing or malformed fields", () => {
    const har = buildHar([
      { type: "network-request", url: "", method: "", status: 0, timestamp: 0 } as NetworkEntry,
      entry({ url: "not a url" }),
    ]) as any;

    expect(har.log.entries).toHaveLength(2);
    expect(() => JSON.stringify(har)).not.toThrow();
    expect(har.log.entries[1].request.queryString).toEqual([]);
  });

  it("handles an empty list", () => {
    const har = buildHar([]) as any;
    expect(har.log.entries).toEqual([]);
  });
});
