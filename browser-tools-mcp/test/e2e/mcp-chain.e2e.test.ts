import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createConnector, type Connector } from "../../src/connector/connector";
import { InProcessConnectorClient } from "../../src/mcp/client";
import { createMcpServer } from "../../src/mcp/server";
import { startFixtureServer, type FixtureServer } from "../fixtures/server";

/**
 * The whole chain, exactly as a user experiences it:
 *
 *   MCP client -> MCP server -> connector -> Chrome extension -> real page
 *
 * The other end-to-end file drives the connector directly, which leaves the
 * MCP layer unproven against a real browser. This closes that.
 */

const extensionPath = path.resolve(
  fileURLToPath(new URL("../../../chrome-extension", import.meta.url))
);

let connector: Connector;
let fixture: FixtureServer;
let context: BrowserContext | null = null;
let client: Client;
let closeServer: (() => Promise<void>) | null = null;
let userDataDir: string;
let screenshotDir: string;

beforeAll(async () => {
  screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-chain-shots-"));
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-chain-profile-"));

  fixture = await startFixtureServer();
  connector = await createConnector({ port: 3025, screenshotDir, heartbeatIntervalMs: 5_000 });

  const { server } = createMcpServer({ client: new InProcessConnectorClient(connector) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "chain-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closeServer = async () => {
    await client.close();
    await server.close();
  };

  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--auto-open-devtools-for-tabs",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
}, 180_000);

afterAll(async () => {
  await closeServer?.();
  await context?.close().catch(() => {});
  await connector?.close();
  await fixture?.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(screenshotDir, { recursive: true, force: true });
});

async function waitFor<T>(
  probe: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 45_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await probe();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out. Last value: ${JSON.stringify(last)?.slice(0, 600)}`);
}

/** Opens the fixture page and returns once capture is live for that tab. */
async function openPage() {
  const page = await context!.newPage();
  await page.goto(fixture.url, { waitUntil: "load" });
  await waitFor(() => connector.hasExtension(), (connected) => connected === true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  connector.store.wipe();
  await page.reload({ waitUntil: "load" });
  return page;
}

describe("MCP client to real browser", () => {
  it("reports the extension as connected through getConnectionStatus", async () => {
    const page = await openPage();

    const result: any = await waitFor(
      () => client.callTool({ name: "getConnectionStatus", arguments: {} }),
      (r: any) => r.structuredContent?.extensionConnected === true
    );

    expect(result.structuredContent.extensionConnected).toBe(true);
    await page.close();
  }, 180_000);

  it("returns real console output as structured content", async () => {
    const page = await openPage();

    const result: any = await waitFor(
      () => client.callTool({ name: "getConsoleLogs", arguments: {} }),
      (r: any) =>
        (r.structuredContent?.entries ?? []).some((e: any) =>
          e.message?.includes("MARKER-CONSOLE-LOG")
        )
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.total).toBeGreaterThan(0);
    await page.close();
  }, 180_000);

  it("filters real console output by keyword through the tool interface", async () => {
    const page = await openPage();

    await waitFor(
      () => client.callTool({ name: "getConsoleLogs", arguments: {} }),
      (r: any) =>
        (r.structuredContent?.entries ?? []).some((e: any) =>
          e.message?.includes("MARKER-CONSOLE-WARN")
        )
    );

    const filtered: any = await client.callTool({
      name: "getConsoleLogs",
      arguments: { keywords: ["MARKER-CONSOLE-WARN"] },
    });

    expect(filtered.structuredContent.entries.length).toBeGreaterThan(0);
    expect(
      filtered.structuredContent.entries.every((e: any) =>
        e.message.includes("MARKER-CONSOLE-WARN")
      )
    ).toBe(true);

    await page.close();
  }, 180_000);

  it("returns real failed requests from getNetworkErrors", async () => {
    const page = await openPage();

    const result: any = await waitFor(
      () => client.callTool({ name: "getNetworkErrors", arguments: {} }),
      (r: any) =>
        (r.structuredContent?.entries ?? []).some((e: any) => e.url?.includes("/api/fail"))
    );

    expect(result.isError).toBeFalsy();
    expect(
      result.structuredContent.entries.find((e: any) => e.url.includes("/api/fail")).status
    ).toBe(500);

    await page.close();
  }, 180_000);

  it("delivers a real screenshot of the page as an image block", async () => {
    const page = await openPage();

    const result: any = await client.callTool({ name: "takeScreenshot", arguments: {} });

    expect(result.isError).toBeFalsy();
    const image = result.content.find((c: any) => c.type === "image");
    expect(image).toBeTruthy();
    expect(image.mimeType).toBe("image/png");

    // A real capture of a real page, not a stub.
    const bytes = Buffer.from(image.data, "base64");
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(bytes.length).toBeGreaterThan(1000);
    expect(fs.existsSync(result.structuredContent.path)).toBe(true);

    await page.close();
  }, 180_000);

  it("reports the real page through getPageInfo", async () => {
    const page = await openPage();

    const result: any = await waitFor(
      () => client.callTool({ name: "getPageInfo", arguments: {} }),
      (r: any) => typeof r.structuredContent?.url === "string" && r.structuredContent.url.includes("127.0.0.1")
    );

    expect(result.structuredContent.extensionConnected).toBe(true);
    await page.close();
  }, 180_000);

  it("reloads the real page through refreshBrowser", async () => {
    const page = await openPage();

    await client.callTool({ name: "wipeLogs", arguments: {} });
    const result: any = await client.callTool({ name: "refreshBrowser", arguments: {} });
    expect(result.isError).toBeFalsy();

    await waitFor(
      () => client.callTool({ name: "getConsoleLogs", arguments: {} }),
      (r: any) =>
        (r.structuredContent?.entries ?? []).some((e: any) =>
          e.message?.includes("MARKER-CONSOLE-LOG")
        )
    );

    await page.close();
  }, 180_000);

  it("withholds real storage values until asked, then returns them", async () => {
    const page = await openPage();
    await page.evaluate(() => {
      localStorage.setItem("chain-key", "CHAIN-SECRET-VALUE");
    });

    const hidden: any = await client.callTool({
      name: "getBrowserStorage",
      arguments: { kinds: ["localStorage"] },
    });
    expect(JSON.stringify(hidden)).toContain("chain-key");
    expect(JSON.stringify(hidden)).not.toContain("CHAIN-SECRET-VALUE");

    const shown: any = await client.callTool({
      name: "getBrowserStorage",
      arguments: { kinds: ["localStorage"], includeValues: true },
    });
    expect(JSON.stringify(shown)).toContain("CHAIN-SECRET-VALUE");

    await page.close();
  }, 180_000);

  it("runs a real audit of the live page through the MCP tool", async () => {
    if (!process.env["CHROME_PATH"]) {
      process.env["CHROME_PATH"] = chromium.executablePath();
    }
    const page = await openPage();

    // No url argument: the tool has to resolve the page the browser is on.
    const result: any = await client.callTool({
      name: "runSEOAudit",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.category).toBe("seo");
    expect(result.structuredContent.metadata.url).toContain("127.0.0.1");

    await page.close();
  }, 240_000);
});
