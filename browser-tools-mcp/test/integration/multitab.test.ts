import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createConnector, type Connector } from "../../src/connector/connector";
import { HttpConnectorClient, InProcessConnectorClient } from "../../src/mcp/client";
import { createMcpServer } from "../../src/mcp/server";
import { FakeExtension, TINY_PNG_BASE64 } from "../helpers/fake-extension";

/**
 * Behaviour when DevTools is open on more than one tab.
 *
 * Each tab runs its own copy of the extension's devtools page and opens its own
 * websocket, so the connector has to decide which tab a screenshot, a refresh or
 * a telemetry read refers to.
 */

let connector: Connector;
const extensions: FakeExtension[] = [];
let screenshotDir: string;

beforeEach(async () => {
  screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-multitab-"));
  connector = await createConnector({
    port: 0,
    screenshotDir,
    requestTimeoutMs: 3_000,
    heartbeatIntervalMs: 60_000,
  });
});

afterEach(async () => {
  await Promise.all(extensions.splice(0).map((ext) => ext.close()));
  await connector?.close();
  fs.rmSync(screenshotDir, { recursive: true, force: true });
});

/** A fake DevTools page for one tab, which reports its own tab id and url. */
async function openTab(tabId: number, url: string, options: Record<string, unknown> = {}) {
  const ext = new FakeExtension({
    port: connector.port,
    tabId,
    // Each tab answers screenshots with a marker so we can tell them apart.
    onScreenshot: () => ({
      ok: true,
      data: `data:image/png;base64,${TINY_PNG_BASE64}`,
      marker: `tab-${tabId}`,
    }),
    ...(options as any),
  });
  await ext.connect();
  await ext.waitForWelcome();
  extensions.push(ext);

  ext.send({ type: "page", url, tabId });

  // Wait for the url, not merely for the tab to exist. A tab is registered on
  // `hello`, which arrives before the `page` frame carrying its url, so waiting
  // on presence alone let the test read a tab whose url was still empty.
  await vi.waitFor(() => {
    const tab = connector.listTabs().find((t) => t.tabId === tabId);
    expect(tab?.url).toBe(url);
  });
  return ext;
}

/** Which tab actually received the most recent screenshot request. */
function tabThatWasAsked(): number | undefined {
  const asked = extensions
    .map((ext, index) => ({
      index,
      request: [...ext.received].reverse().find((m) => m.type === "capture-screenshot"),
    }))
    .filter((entry) => entry.request);

  const newest = asked.sort(
    (a, b) => (b.request.__seq ?? 0) - (a.request.__seq ?? 0)
  )[0];
  return newest?.index;
}

describe("tab registry", () => {
  it("lists every connected tab with its url", async () => {
    await openTab(1, "https://example.com/one");
    await openTab(2, "https://example.com/two");

    const tabs = connector.listTabs();
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.tabId).sort()).toEqual([1, 2]);
    expect(tabs.find((t) => t.tabId === 2)?.url).toBe("https://example.com/two");
  });

  it("marks exactly one tab as current", async () => {
    await openTab(1, "https://example.com/one");
    await openTab(2, "https://example.com/two");

    expect(connector.listTabs().filter((t) => t.isCurrent)).toHaveLength(1);
  });

  it("treats the most recently attached tab as current", async () => {
    await openTab(1, "https://example.com/one");
    await openTab(2, "https://example.com/two");

    expect(connector.getCurrentTabId()).toBe(2);
  });

  it("drops a tab from the registry when its DevTools closes", async () => {
    await openTab(1, "https://example.com/one");
    const second = await openTab(2, "https://example.com/two");

    await second.close();
    await vi.waitFor(() => expect(connector.listTabs()).toHaveLength(1));

    // The remaining tab has to become current; nothing else is left to be.
    expect(connector.getCurrentTabId()).toBe(1);
  });
});

describe("which tab is current", () => {
  /**
   * The reported bug: a backgrounded tab is timer-throttled, misses heartbeat
   * pongs, gets dropped, and on reconnect silently steals the current tab from
   * the one the user is actually looking at.
   */
  it("does not let a reconnecting tab steal current from the foreground tab", async () => {
    const first = await openTab(1, "https://example.com/one");
    await openTab(2, "https://example.com/two");
    expect(connector.getCurrentTabId()).toBe(2);

    // Tab 1's DevTools drops and comes back.
    await first.close();
    await vi.waitFor(() => expect(connector.listTabs()).toHaveLength(1));
    await openTab(1, "https://example.com/one");

    expect(connector.getCurrentTabId()).toBe(2);
  });

  it("does not let a background tab navigating on a timer steal current", async () => {
    await openTab(1, "https://example.com/one");
    const second = await openTab(2, "https://example.com/two");
    expect(connector.getCurrentTabId()).toBe(2);

    // Tab 1 navigates by itself while the user is looking at tab 2.
    extensions[0]!.send({ type: "page", url: "https://example.com/one-b", tabId: 1 });
    await vi.waitFor(() => {
      expect(connector.listTabs().find((t) => t.tabId === 1)?.url).toBe(
        "https://example.com/one-b"
      );
    });

    expect(connector.getCurrentTabId()).toBe(2);
    void second;
  });

  it("lets a caller set the current tab explicitly", async () => {
    await openTab(1, "https://example.com/one");
    await openTab(2, "https://example.com/two");

    connector.setCurrentTab(1);
    expect(connector.getCurrentTabId()).toBe(1);
  });

  it("refuses to make an unknown tab current", async () => {
    await openTab(1, "https://example.com/one");
    expect(() => connector.setCurrentTab(999)).toThrow(/unknown tab/i);
  });
});

describe("telemetry attribution", () => {
  it("tags entries with the tab that produced them", async () => {
    await openTab(1, "https://example.com/one");
    await openTab(2, "https://example.com/two");

    extensions[0]!.send({
      type: "console",
      entries: [{ type: "console-log", message: "FROM-TAB-1", timestamp: Date.now() }],
    });
    extensions[1]!.send({
      type: "console",
      entries: [{ type: "console-log", message: "FROM-TAB-2", timestamp: Date.now() }],
    });

    await vi.waitFor(() => expect(connector.store.queryConsole({}).total).toBe(2));

    const all = connector.store.queryConsole({});
    expect(all.entries.find((e) => e.message === "FROM-TAB-1")?.tabId).toBe(1);
    expect(all.entries.find((e) => e.message === "FROM-TAB-2")?.tabId).toBe(2);
  });

  it("filters telemetry by tab", async () => {
    await openTab(1, "https://example.com/one");
    await openTab(2, "https://example.com/two");

    extensions[0]!.send({
      type: "console",
      entries: [{ type: "console-log", message: "ONLY-1", timestamp: Date.now() }],
    });
    extensions[1]!.send({
      type: "network",
      entries: [{ url: "https://api.two/x", method: "GET", status: 500, timestamp: Date.now() }],
    });

    await vi.waitFor(() => expect(connector.store.queryConsole({}).total).toBe(1));

    expect(connector.store.queryConsole({ tabId: 1 }).returned).toBe(1);
    expect(connector.store.queryConsole({ tabId: 2 }).returned).toBe(0);
    expect(connector.store.queryNetwork({ tabId: 2 }).returned).toBe(1);
    expect(connector.store.queryNetwork({ tabId: 1 }).returned).toBe(0);
  });

  it("keeps one noisy tab from evicting another tab's logs", async () => {
    connector.store.updateSettings({ logLimit: 5 });
    await openTab(1, "https://example.com/one");
    await openTab(2, "https://example.com/two");

    extensions[0]!.send({
      type: "console",
      entries: [{ type: "console-log", message: "QUIET-TAB-1", timestamp: Date.now() }],
    });
    await vi.waitFor(() => expect(connector.store.queryConsole({ tabId: 1 }).returned).toBe(1));

    extensions[1]!.send({
      type: "console",
      entries: Array.from({ length: 50 }, (_, i) => ({
        type: "console-log",
        message: `noisy-${i}`,
        timestamp: Date.now() + i,
      })),
    });
    await vi.waitFor(() => expect(connector.store.queryConsole({ tabId: 2 }).returned).toBe(5));

    // Retention is per tab, so the quiet tab's single entry survives.
    expect(connector.store.queryConsole({ tabId: 1 }).returned).toBe(1);
  });

  it("keeps the selected element per tab", async () => {
    await openTab(1, "https://example.com/one");
    await openTab(2, "https://example.com/two");

    extensions[0]!.send({ type: "selected-element", element: { tagName: "BUTTON" }, tabId: 1 });
    extensions[1]!.send({ type: "selected-element", element: { tagName: "INPUT" }, tabId: 2 });

    await vi.waitFor(() => {
      expect(connector.store.getSelectedElement(1)).toMatchObject({ tagName: "BUTTON" });
    });
    expect(connector.store.getSelectedElement(2)).toMatchObject({ tagName: "INPUT" });
  });

  it("wipes a single tab without touching the others", async () => {
    await openTab(1, "https://example.com/one");
    await openTab(2, "https://example.com/two");

    extensions[0]!.send({
      type: "console",
      entries: [{ type: "console-log", message: "keep-me", timestamp: Date.now() }],
    });
    extensions[1]!.send({
      type: "console",
      entries: [{ type: "console-log", message: "drop-me", timestamp: Date.now() }],
    });
    await vi.waitFor(() => expect(connector.store.queryConsole({}).total).toBe(2));

    connector.store.wipe(2);

    expect(connector.store.queryConsole({ tabId: 1 }).returned).toBe(1);
    expect(connector.store.queryConsole({ tabId: 2 }).returned).toBe(0);
  });
});

describe("addressing requests to a tab", () => {
  it("sends a screenshot request to the current tab by default", async () => {
    await openTab(1, "https://example.com/one");
    await openTab(2, "https://example.com/two");

    await connector.captureScreenshot({});

    expect(extensions[1]!.received.some((m) => m.type === "capture-screenshot")).toBe(true);
    expect(extensions[0]!.received.some((m) => m.type === "capture-screenshot")).toBe(false);
    void tabThatWasAsked;
  });

  it("sends a screenshot request to a named tab", async () => {
    await openTab(1, "https://example.com/one");
    await openTab(2, "https://example.com/two");

    await connector.captureScreenshot({ tabId: 1 });

    expect(extensions[0]!.received.some((m) => m.type === "capture-screenshot")).toBe(true);
    expect(extensions[1]!.received.some((m) => m.type === "capture-screenshot")).toBe(false);
  });

  it("refreshes a named tab", async () => {
    await openTab(1, "https://example.com/one");
    await openTab(2, "https://example.com/two");

    await connector.refreshTab({ tabId: 1 });

    expect(extensions[0]!.received.some((m) => m.type === "refresh-tab")).toBe(true);
    expect(extensions[1]!.received.some((m) => m.type === "refresh-tab")).toBe(false);
  });

  it("reads storage from a named tab", async () => {
    await openTab(1, "https://example.com/one", {
      onStorage: () => ({ ok: true, storage: { localStorage: { which: "one" } } }),
    });
    await openTab(2, "https://example.com/two", {
      onStorage: () => ({ ok: true, storage: { localStorage: { which: "two" } } }),
    });

    expect(await connector.readStorage(["localStorage"], { tabId: 1 })).toMatchObject({
      localStorage: { which: "one" },
    });
  });

  it("fails clearly when the named tab is not connected", async () => {
    await openTab(1, "https://example.com/one");

    await expect(connector.captureScreenshot({ tabId: 42 })).rejects.toThrow(/tab 42/i);
  });

  it("still works with a single tab and no tab argument", async () => {
    await openTab(7, "https://example.com/only");

    const result = await connector.captureScreenshot({});
    expect(fs.existsSync(result.path)).toBe(true);
  });
});

describe("through the MCP tools", () => {
  let client: Client;
  let closeServer: () => Promise<void>;

  async function startServer() {
    const { server } = createMcpServer({ client: new InProcessConnectorClient(connector) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "multitab-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeServer = async () => {
      await client.close();
      await server.close();
    };
  }

  afterEach(async () => {
    await closeServer?.();
  });

  async function seedTwoTabs() {
    await openTab(1, "https://example.com/one");
    await openTab(2, "https://example.com/two");
    extensions[0]!.send({
      type: "console",
      entries: [{ type: "console-log", message: "ONLY-IN-TAB-1", timestamp: Date.now() }],
    });
    extensions[1]!.send({
      type: "console",
      entries: [{ type: "console-log", message: "ONLY-IN-TAB-2", timestamp: Date.now() }],
    });
    await vi.waitFor(() => expect(connector.store.queryConsole({}).total).toBe(2));
  }

  it("lists the connected tabs", async () => {
    await startServer();
    await seedTwoTabs();

    const result: any = await client.callTool({ name: "listBrowserTabs", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.tabs).toHaveLength(2);
    expect(result.structuredContent.currentTabId).toBe(2);
    expect(result.structuredContent.tabs.filter((t: any) => t.isCurrent)).toHaveLength(1);
  });

  it("reads the current tab by default", async () => {
    await startServer();
    await seedTwoTabs();

    const result: any = await client.callTool({ name: "getConsoleLogs", arguments: {} });
    const messages = result.structuredContent.entries.map((e: any) => e.message);

    expect(messages).toEqual(["ONLY-IN-TAB-2"]);
    expect(result.structuredContent.tabId).toBe(2);
  });

  it("reads a named tab when asked", async () => {
    await startServer();
    await seedTwoTabs();

    const result: any = await client.callTool({
      name: "getConsoleLogs",
      arguments: { tabId: 1 },
    });

    expect(result.structuredContent.entries.map((e: any) => e.message)).toEqual([
      "ONLY-IN-TAB-1",
    ]);
    expect(result.structuredContent.tabId).toBe(1);
  });

  it("reads every tab when asked for all of them", async () => {
    await startServer();
    await seedTwoTabs();

    const result: any = await client.callTool({
      name: "getConsoleLogs",
      arguments: { allTabs: true },
    });

    expect(result.structuredContent.entries).toHaveLength(2);
  });

  it("tells the agent when other tabs exist", async () => {
    await startServer();
    await seedTwoTabs();

    const page: any = await client.callTool({ name: "getPageInfo", arguments: {} });
    expect(page.structuredContent.connectedTabs).toBe(2);

    const logs: any = await client.callTool({ name: "getConsoleLogs", arguments: {} });
    expect(logs.structuredContent.otherTabs).toBe(1);
  });

  it("says which tab a screenshot came from", async () => {
    await startServer();
    await seedTwoTabs();

    const result: any = await client.callTool({
      name: "takeScreenshot",
      arguments: { tabId: 1 },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.tabId).toBe(1);
    expect(result.structuredContent.url).toBe("https://example.com/one");
    expect(extensions[0]!.received.some((m) => m.type === "capture-screenshot")).toBe(true);
    expect(extensions[1]!.received.some((m) => m.type === "capture-screenshot")).toBe(false);
  });

  it("reports an unknown tab clearly instead of guessing", async () => {
    await startServer();
    await seedTwoTabs();

    const result: any = await client.callTool({
      name: "getConsoleLogs",
      arguments: { tabId: 999 },
    });

    expect(result.isError).toBe(true);
    const text = result.content.map((c: any) => c.text).join(" ");
    expect(text).toMatch(/unknown tab 999/i);
    // The message has to say what the agent should do next.
    expect(text).toMatch(/listBrowserTabs/i);
  });

  it("behaves identically over HTTP and in-process", async () => {
    await startServer();
    await seedTwoTabs();

    const http = new HttpConnectorClient({
      baseUrl: `http://127.0.0.1:${connector.port}`,
      token: connector.token,
    });
    const inProcess = new InProcessConnectorClient(connector);

    const overHttp = await http.console({ tabId: 1 });
    const inline = await inProcess.console({ tabId: 1 });

    // A tabId silently ignored on one transport is the kind of divergence that
    // makes multi-tab targeting untrustworthy.
    expect(overHttp.entries.map((e) => e.message)).toEqual(["ONLY-IN-TAB-1"]);
    expect(inline.entries.map((e) => e.message)).toEqual(["ONLY-IN-TAB-1"]);
  });
});
