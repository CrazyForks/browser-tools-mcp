import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createConnector, type Connector } from "../../src/connector/connector";
import { InProcessConnectorClient } from "../../src/mcp/client";
import { createMcpServer } from "../../src/mcp/server";
import { FakeExtension, TINY_PNG_BASE64 } from "../helpers/fake-extension";

/**
 * Screenshot format and size handling.
 *
 * A full-viewport capture on a high-DPI display can exceed 10 MB of base64 —
 * more than a model's context can take, and past the read buffer newer MCP
 * stdio transports enforce, which severs the connection.
 */

let connector: Connector;
let extension: FakeExtension | null = null;
let screenshotDir: string;

// Small but valid JPEG bytes, so the format path is exercised with real data.
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

beforeEach(async () => {
  screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-shot-"));
  connector = await createConnector({ port: 0, screenshotDir, requestTimeoutMs: 3_000 });
});

afterEach(async () => {
  await extension?.close();
  extension = null;
  await connector?.close();
  fs.rmSync(screenshotDir, { recursive: true, force: true });
});

async function connectExtension(options: Record<string, unknown> = {}) {
  const ext = new FakeExtension({ port: connector.port, ...(options as any) });
  await ext.connect();
  await ext.waitForWelcome();
  extension = ext;
  return ext;
}

describe("format handling", () => {
  it("tells the browser what byte budget to hit", async () => {
    const ext = await connectExtension();
    await connector.captureScreenshot({});

    const request = ext.received.find((m) => m.type === "capture-screenshot");
    expect(request.maxBytes).toBe(connector.store.settings.screenshotMaxBytes);
  });

  it("passes the current budget through after a settings change", async () => {
    connector.store.updateSettings({ screenshotMaxBytes: 250_000 });
    const ext = await connectExtension();
    await connector.captureScreenshot({});

    const request = ext.received.find((m) => m.type === "capture-screenshot");
    expect(request.maxBytes).toBe(250_000);
  });

  it("saves a png as .png and reports its type", async () => {
    await connectExtension();
    const result = await connector.captureScreenshot({});

    expect(result.mimeType).toBe("image/png");
    expect(result.path.endsWith(".png")).toBe(true);
    expect(fs.readFileSync(result.path).subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );
  });

  it("saves a jpeg as .jpg when the browser fell back to it", async () => {
    await connectExtension({
      onScreenshot: () => ({ ok: true, data: `data:image/jpeg;base64,${TINY_JPEG_BASE64}` }),
    });
    const result = await connector.captureScreenshot({});

    expect(result.mimeType).toBe("image/jpeg");
    expect(result.path.endsWith(".jpg")).toBe(true);
    // Real JPEG magic bytes, not PNG data in a renamed file.
    expect(fs.readFileSync(result.path).subarray(0, 3)).toEqual(
      Buffer.from([0xff, 0xd8, 0xff])
    );
  });

  it("corrects a caller-supplied name whose extension no longer matches", async () => {
    await connectExtension({
      onScreenshot: () => ({ ok: true, data: `data:image/jpeg;base64,${TINY_JPEG_BASE64}` }),
    });
    const result = await connector.captureScreenshot({ name: "myshot.png" });

    // JPEG bytes must not end up in a .png file.
    expect(path.basename(result.path)).toBe("myshot.jpg");
    expect(fs.existsSync(path.join(screenshotDir, "myshot.png"))).toBe(false);
  });

  it("returns a data url carrying the real mime type", async () => {
    await connectExtension({
      onScreenshot: () => ({ ok: true, data: `data:image/jpeg;base64,${TINY_JPEG_BASE64}` }),
    });
    const result = await connector.captureScreenshot({});
    expect(result.data.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("rejects an unsupported image format instead of writing junk", async () => {
    await connectExtension({
      onScreenshot: () => ({ ok: true, data: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }),
    });

    await expect(connector.captureScreenshot({})).rejects.toThrow(/unsupported|empty/i);
    expect(fs.readdirSync(screenshotDir)).toEqual([]);
  });

  it("rejects an empty payload", async () => {
    await connectExtension({ onScreenshot: () => ({ ok: true, data: "" }) });
    await expect(connector.captureScreenshot({})).rejects.toThrow();
  });
});

describe("size budget", () => {
  const oversized = () => "A".repeat(400_000); // ~300 KB decoded

  it("reports an image that fits as within budget", async () => {
    await connectExtension();
    const result = await connector.captureScreenshot({});

    expect(result.withinBudget).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.bytes).toBeLessThan(connector.store.settings.screenshotMaxBytes);
  });

  it("flags an oversized image but still saves it to disk", async () => {
    connector.store.updateSettings({ screenshotMaxBytes: 50_000 });
    await connectExtension({
      onScreenshot: () => ({ ok: true, data: `data:image/png;base64,${oversized()}` }),
    });

    const result = await connector.captureScreenshot({});

    expect(result.withinBudget).toBe(false);
    expect(result.bytes).toBeGreaterThan(50_000);
    // The user can still open the file even though the model will not see it.
    expect(fs.existsSync(result.path)).toBe(true);
  });
});

describe("through the MCP tool", () => {
  let client: Client;
  let closeServer: () => Promise<void>;

  async function startServer() {
    const { server } = createMcpServer({ client: new InProcessConnectorClient(connector) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "shot-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeServer = async () => {
      await client.close();
      await server.close();
    };
  }

  afterEach(async () => {
    await closeServer?.();
  });

  it("inlines an image that fits, with its real mime type", async () => {
    await startServer();
    await connectExtension({
      onScreenshot: () => ({ ok: true, data: `data:image/jpeg;base64,${TINY_JPEG_BASE64}` }),
    });

    const result: any = await client.callTool({ name: "takeScreenshot", arguments: {} });
    const image = result.content.find((c: any) => c.type === "image");

    expect(image.mimeType).toBe("image/jpeg");
    expect(result.structuredContent.imageIncluded).toBe(true);
    expect(result.structuredContent.bytes).toBeGreaterThan(0);
  });

  // The important one: an oversized image must never be inlined, because doing
  // so blows the context window and can sever a newer stdio transport.
  it("omits an oversized image and explains where to find it", async () => {
    connector.store.updateSettings({ screenshotMaxBytes: 50_000 });
    await startServer();
    await connectExtension({
      onScreenshot: () => ({ ok: true, data: `data:image/png;base64,${"A".repeat(400_000)}` }),
    });

    const result: any = await client.callTool({ name: "takeScreenshot", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.content.some((c: any) => c.type === "image")).toBe(false);
    expect(result.structuredContent.imageIncluded).toBe(false);

    const text = result.content.map((c: any) => c.text).join("\n");
    expect(text).toMatch(/too large/i);
    expect(text).toContain(result.structuredContent.path);

    // Nothing approaching the transport's 10 MB read buffer went over the wire.
    expect(JSON.stringify(result).length).toBeLessThan(100_000);
  });
});
