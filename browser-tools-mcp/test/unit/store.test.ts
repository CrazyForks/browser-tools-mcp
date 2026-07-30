import { describe, it, expect, beforeEach } from "vitest";
import { TelemetryStore } from "../../src/connector/store";

let store: TelemetryStore;

beforeEach(() => {
  store = new TelemetryStore();
});

const consoleEntry = (over: Record<string, unknown> = {}) => ({
  type: "console-log",
  level: "log",
  message: "hello world",
  timestamp: Date.now(),
  ...over,
});

const networkEntry = (over: Record<string, unknown> = {}) => ({
  type: "network-request",
  url: "https://api.example.com/users",
  method: "GET",
  status: 200,
  timestamp: Date.now(),
  ...over,
});

describe("ingest", () => {
  it("stores console entries and reports them back", () => {
    store.addConsole(consoleEntry({ message: "first" }));
    const result = store.queryConsole({});
    expect(result.total).toBe(1);
    expect(result.entries[0]!.message).toBe("first");
  });

  it("classifies console errors separately from logs", () => {
    store.addConsole(consoleEntry({ type: "console-error", level: "error", message: "boom" }));
    store.addConsole(consoleEntry({ message: "fine" }));

    expect(store.queryConsole({ errorsOnly: true }).total).toBe(1);
    expect(store.queryConsole({ errorsOnly: true }).entries[0]!.message).toBe("boom");
    expect(store.queryConsole({}).total).toBe(2);
  });

  it("splits network entries into successes and errors by status", () => {
    store.addNetwork(networkEntry({ status: 200 }));
    store.addNetwork(networkEntry({ status: 404 }));
    store.addNetwork(networkEntry({ status: 500 }));

    expect(store.queryNetwork({ errorsOnly: true }).total).toBe(2);
    expect(store.queryNetwork({}).total).toBe(3);
  });

  it("treats a failed request with no status as an error", () => {
    store.addNetwork(networkEntry({ status: 0, error: "net::ERR_CONNECTION_REFUSED" }));
    expect(store.queryNetwork({ errorsOnly: true }).total).toBe(1);
  });

  it("ignores malformed entries instead of throwing", () => {
    expect(() => store.addConsole(null)).not.toThrow();
    expect(() => store.addConsole("nonsense" as unknown)).not.toThrow();
    expect(() => store.addNetwork(undefined)).not.toThrow();
    expect(store.queryConsole({}).total).toBe(0);
  });

  it("evicts the oldest entries past the log limit, keeping the newest", () => {
    store.updateSettings({ logLimit: 3 });
    for (let i = 1; i <= 6; i++) store.addConsole(consoleEntry({ message: `m${i}` }));

    const result = store.queryConsole({});
    expect(result.total).toBe(3);
    expect(result.entries.map((e) => e.message)).toEqual(["m4", "m5", "m6"]);
  });

  it("applies a shrunk log limit to already-stored entries", () => {
    for (let i = 1; i <= 10; i++) store.addConsole(consoleEntry({ message: `m${i}` }));
    store.updateSettings({ logLimit: 2 });
    expect(store.queryConsole({}).total).toBe(2);
  });
});

describe("redaction at ingest", () => {
  it("redacts credential headers on network entries", () => {
    store.updateSettings({ showRequestHeaders: true, showResponseHeaders: true });
    store.addNetwork(
      networkEntry({
        requestHeaders: { Authorization: "Bearer secret-token-value", Accept: "application/json" },
        responseHeaders: { "Set-Cookie": "sid=abc123" },
      })
    );

    const entry = store.queryNetwork({}).entries[0]!;
    expect(entry.requestHeaders!.Authorization).toBe("[REDACTED]");
    expect(entry.requestHeaders!.Accept).toBe("application/json");
    expect(entry.responseHeaders!["Set-Cookie"]).toBe("[REDACTED]");
  });

  it("redacts secrets inside console messages", () => {
    store.addConsole(
      consoleEntry({ message: "auth failed for ghp_1234567890abcdefghijklmnopqrstuvwx" })
    );
    const entry = store.queryConsole({}).entries[0]!;
    expect(entry.message).not.toContain("ghp_1234567890");
    expect(entry.message).toContain("[REDACTED]");
  });

  it("redacts secrets inside response bodies", () => {
    store.addNetwork(networkEntry({ responseBody: '{"token":"hunter2","ok":true}' }));
    const entry = store.queryNetwork({}).entries[0]!;
    expect(entry.responseBody).not.toContain("hunter2");
  });

  it("can be turned off for users who need raw values", () => {
    const raw = new TelemetryStore({ redact: false });
    raw.updateSettings({ showRequestHeaders: true });
    raw.addNetwork(networkEntry({ requestHeaders: { Authorization: "Bearer keepme" } }));
    expect(raw.queryNetwork({}).entries[0]!.requestHeaders!.Authorization).toBe("Bearer keepme");
  });
});

describe("header visibility", () => {
  it("omits headers unless explicitly enabled", () => {
    store.addNetwork(
      networkEntry({
        requestHeaders: { Accept: "application/json" },
        responseHeaders: { "Content-Type": "application/json" },
      })
    );

    const entry = store.queryNetwork({}).entries[0]!;
    expect(entry.requestHeaders).toBeUndefined();
    expect(entry.responseHeaders).toBeUndefined();
  });

  it("includes each header direction independently", () => {
    store.updateSettings({ showRequestHeaders: true });
    store.addNetwork(
      networkEntry({
        requestHeaders: { Accept: "application/json" },
        responseHeaders: { "Content-Type": "application/json" },
      })
    );

    const entry = store.queryNetwork({}).entries[0]!;
    expect(entry.requestHeaders).toBeDefined();
    expect(entry.responseHeaders).toBeUndefined();
  });
});

describe("truncation", () => {
  it("caps individual captured strings at stringSizeLimit", () => {
    store.updateSettings({ stringSizeLimit: 100 });
    store.addNetwork(networkEntry({ responseBody: "y".repeat(5000) }));
    const entry = store.queryNetwork({}).entries[0]!;
    expect(entry.responseBody!.length).toBeLessThan(200);
    expect(entry.responseBody).toContain("truncated");
  });

  it("keeps a query inside the character budget and flags it", () => {
    store.updateSettings({ logLimit: 500, queryLimit: 2000, stringSizeLimit: 1000 });
    for (let i = 0; i < 200; i++) {
      store.addConsole(consoleEntry({ message: `entry ${i} ${"z".repeat(300)}` }));
    }
    const result = store.queryConsole({});
    expect(JSON.stringify(result.entries).length).toBeLessThan(6000);
    expect(result.returned).toBeLessThan(result.total);
    expect(result.truncated).toBe(true);
  });
});

describe("filtering", () => {
  it("filters console entries by keyword, case-insensitively", () => {
    store.addConsole(consoleEntry({ message: "Hydration mismatch in Header" }));
    store.addConsole(consoleEntry({ message: "unrelated chatter" }));

    const result = store.queryConsole({ keywords: ["hydration"] });
    expect(result.returned).toBe(1);
    expect(result.entries[0]!.message).toContain("Hydration");
  });

  it("treats multiple keywords as OR", () => {
    store.addConsole(consoleEntry({ message: "alpha" }));
    store.addConsole(consoleEntry({ message: "beta" }));
    store.addConsole(consoleEntry({ message: "gamma" }));

    expect(store.queryConsole({ keywords: ["alpha", "gamma"] }).returned).toBe(2);
  });

  // Regression for the filtering approach proposed in PR #218, which called
  // .includes() on fields that are frequently absent.
  it("does not throw when filtered fields are missing or non-string", () => {
    store.addConsole(consoleEntry({ message: undefined }));
    store.addConsole(consoleEntry({ message: 42 }));
    store.addNetwork(networkEntry({ responseBody: undefined, url: undefined }));

    expect(() => store.queryConsole({ keywords: ["anything"] })).not.toThrow();
    expect(() => store.queryNetwork({ urlKeywords: ["api"] })).not.toThrow();
    expect(() => store.queryNetwork({ bodyKeywords: ["token"] })).not.toThrow();
  });

  it("filters network entries by url keyword", () => {
    store.addNetwork(networkEntry({ url: "https://api.example.com/users" }));
    store.addNetwork(networkEntry({ url: "https://cdn.example.com/logo.png" }));

    const result = store.queryNetwork({ urlKeywords: ["/users"] });
    expect(result.returned).toBe(1);
  });

  it("filters network entries by response body keyword", () => {
    store.addNetwork(networkEntry({ responseBody: '{"error":"quota exceeded"}' }));
    store.addNetwork(networkEntry({ responseBody: '{"ok":true}' }));

    expect(store.queryNetwork({ bodyKeywords: ["quota"] }).returned).toBe(1);
  });

  it("combines errorsOnly with keyword filters", () => {
    store.addNetwork(networkEntry({ status: 500, url: "https://api.example.com/a" }));
    store.addNetwork(networkEntry({ status: 500, url: "https://other.com/b" }));
    store.addNetwork(networkEntry({ status: 200, url: "https://api.example.com/c" }));

    const result = store.queryNetwork({ errorsOnly: true, urlKeywords: ["api.example.com"] });
    expect(result.returned).toBe(1);
  });
});

describe("pagination", () => {
  beforeEach(() => {
    store.updateSettings({ logLimit: 100 });
    for (let i = 1; i <= 20; i++) store.addConsole(consoleEntry({ message: `m${i}` }));
  });

  it("returns the newest page by default and reports the total", () => {
    const result = store.queryConsole({ limit: 5 });
    expect(result.total).toBe(20);
    expect(result.returned).toBe(5);
    expect(result.entries.map((e) => e.message)).toEqual(["m16", "m17", "m18", "m19", "m20"]);
  });

  it("walks backwards through history with offset", () => {
    const result = store.queryConsole({ limit: 5, offset: 5 });
    expect(result.entries.map((e) => e.message)).toEqual(["m11", "m12", "m13", "m14", "m15"]);
  });

  it("returns an empty page past the end", () => {
    expect(store.queryConsole({ limit: 5, offset: 500 }).returned).toBe(0);
  });
});

describe("page state and wipe", () => {
  it("tracks the current url and tab", () => {
    store.setCurrentPage({ url: "https://example.com/a", tabId: 7 });
    expect(store.getCurrentPage().url).toBe("https://example.com/a");
    expect(store.getCurrentPage().tabId).toBe(7);
  });

  it("stores the selected element", () => {
    store.setSelectedElement({ tagName: "BUTTON", id: "submit" });
    expect(store.getSelectedElement()).toMatchObject({ tagName: "BUTTON" });
  });

  it("wipes every category", () => {
    store.addConsole(consoleEntry());
    store.addNetwork(networkEntry());
    store.setSelectedElement({ tagName: "DIV" });

    store.wipe();

    expect(store.queryConsole({}).total).toBe(0);
    expect(store.queryNetwork({}).total).toBe(0);
    expect(store.getSelectedElement()).toBeNull();
  });
});
