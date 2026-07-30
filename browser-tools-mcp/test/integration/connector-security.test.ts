import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createConnector, type Connector } from "../../src/connector/connector";
import { tryWebSocket, TINY_PNG_BASE64 } from "../helpers/fake-extension";

/**
 * These are the regression tests for the vulnerabilities that were live in
 * 1.2.x: an unauthenticated, LAN-reachable control plane with wildcard CORS,
 * and a screenshot path that reached a shell.
 */

let connector: Connector;
let screenshotDir: string;

beforeAll(async () => {
  screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-sec-"));
  connector = await createConnector({ port: 0, screenshotDir });
});

afterAll(async () => {
  await connector?.close();
  fs.rmSync(screenshotDir, { recursive: true, force: true });
});

describe("network exposure", () => {
  it("binds loopback only, never 0.0.0.0", () => {
    const address = connector.server.address();
    expect(address).toBeTypeOf("object");
    expect((address as any).address).toBe("127.0.0.1");
  });

  it("refuses to bind a non-loopback interface without an explicit override", async () => {
    await expect(createConnector({ port: 0, host: "0.0.0.0" })).rejects.toThrow(
      /loopback/i
    );
  });
});

describe("CORS and origin handling", () => {
  it("never emits a wildcard access-control-allow-origin", async () => {
    const res = await request(connector.app).get("/.identity");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not answer preflight with permissive headers", async () => {
    const res = await request(connector.app)
      .options("/api/console")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects API requests carrying a web page origin, even with a valid token", async () => {
    const res = await request(connector.app)
      .get("/api/console")
      .set("Origin", "https://evil.example")
      .set("Authorization", `Bearer ${connector.token}`);

    expect(res.status).toBe(403);
  });

  it("rejects requests with a foreign Host header (DNS rebinding)", async () => {
    const res = await request(connector.app)
      .get("/api/console")
      .set("Host", "attacker.example.com")
      .set("Authorization", `Bearer ${connector.token}`);

    expect(res.status).toBe(403);
  });
});

describe("HTTP authentication", () => {
  const protectedRoutes: Array<[string, string]> = [
    ["get", "/api/console"],
    ["get", "/api/network"],
    ["get", "/api/selected-element"],
    ["get", "/api/page"],
    ["post", "/api/wipe"],
    ["post", "/api/screenshot"],
    ["post", "/api/refresh"],
    ["post", "/api/storage"],
  ];

  for (const [method, route] of protectedRoutes) {
    it(`rejects unauthenticated ${method.toUpperCase()} ${route}`, async () => {
      const res = await (request(connector.app) as any)[method](route);
      expect(res.status).toBe(401);
    });
  }

  it("rejects a wrong token", async () => {
    const res = await request(connector.app)
      .get("/api/console")
      .set("Authorization", "Bearer not-the-token");
    expect(res.status).toBe(401);
  });

  it("accepts the correct token", async () => {
    const res = await request(connector.app)
      .get("/api/console")
      .set("Authorization", `Bearer ${connector.token}`);
    expect(res.status).toBe(200);
  });

  it("leaves the identity endpoint public so the extension can find the server", async () => {
    const res = await request(connector.app).get("/.identity");
    expect(res.status).toBe(200);
    expect(res.body.signature).toBe("mcp-browser-connector-24x7");
  });

  it("does not leak the token from the identity endpoint", async () => {
    const res = await request(connector.app).get("/.identity");
    expect(JSON.stringify(res.body)).not.toContain(connector.token);
  });
});

describe("websocket upgrade", () => {
  it("accepts a chrome extension origin", async () => {
    const result = await tryWebSocket(
      `ws://127.0.0.1:${connector.port}/extension-ws`,
      { origin: "chrome-extension://abcdefghijklmnop" }
    );
    expect(result.accepted).toBe(true);
  });

  it("accepts a firefox extension origin", async () => {
    const result = await tryWebSocket(
      `ws://127.0.0.1:${connector.port}/extension-ws`,
      { origin: "moz-extension://abcdefghijklmnop" }
    );
    expect(result.accepted).toBe(true);
  });

  // The core of the old vulnerability: any visited web page could open this
  // socket and impersonate the extension.
  it("rejects a web page origin", async () => {
    const result = await tryWebSocket(
      `ws://127.0.0.1:${connector.port}/extension-ws`,
      { origin: "https://evil.example" }
    );
    expect(result.accepted).toBe(false);
  });

  it("rejects an http localhost origin", async () => {
    const result = await tryWebSocket(
      `ws://127.0.0.1:${connector.port}/extension-ws`,
      { origin: "http://localhost:3000" }
    );
    expect(result.accepted).toBe(false);
  });

  it("rejects an originless connection that has no token", async () => {
    const result = await tryWebSocket(
      `ws://127.0.0.1:${connector.port}/extension-ws`
    );
    expect(result.accepted).toBe(false);
  });

  it("allows an originless connection that presents the token", async () => {
    const result = await tryWebSocket(
      `ws://127.0.0.1:${connector.port}/extension-ws?token=${connector.token}`
    );
    expect(result.accepted).toBe(true);
  });

  it("rejects unknown websocket paths", async () => {
    const result = await tryWebSocket(`ws://127.0.0.1:${connector.port}/anything`, {
      origin: "chrome-extension://abcdefghijklmnop",
    });
    expect(result.accepted).toBe(false);
  });
});

describe("screenshot path handling", () => {
  it("keeps caller-supplied names inside the screenshot directory", async () => {
    const res = await request(connector.app)
      .post("/api/screenshot")
      .set("Authorization", `Bearer ${connector.token}`)
      .send({ name: "../../escape.png" });

    // No extension is connected, so this cannot succeed — but it must fail on
    // the path, not attempt the write.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(path.join(screenshotDir, "..", "..", "escape.png"))).toBe(false);
  });

  it("rejects names containing shell metacharacters", async () => {
    const res = await request(connector.app)
      .post("/api/screenshot")
      .set("Authorization", `Bearer ${connector.token}`)
      .send({ name: "shot'$(touch /tmp/pwned).png" });

    expect(res.status).toBe(400);
  });

  it("never accepts an absolute path", async () => {
    const res = await request(connector.app)
      .post("/api/screenshot")
      .set("Authorization", `Bearer ${connector.token}`)
      .send({ name: "/tmp/anywhere.png" });

    expect(res.status).toBe(400);
  });
});

describe("settings hardening", () => {
  it("ignores unknown settings keys pushed over the API", async () => {
    await request(connector.app)
      .post("/api/settings")
      .set("Authorization", `Bearer ${connector.token}`)
      .send({ logLimit: 10, screenshotPath: "/etc", serverHost: "0.0.0.0" })
      .expect(200);

    expect(connector.store.settings.logLimit).toBe(10);
    expect(connector.store.settings).not.toHaveProperty("screenshotPath");
    expect(connector.store.settings).not.toHaveProperty("serverHost");
  });

  it("clamps a hostile log limit instead of exhausting memory", async () => {
    await request(connector.app)
      .post("/api/settings")
      .set("Authorization", `Bearer ${connector.token}`)
      .send({ logLimit: 1e9 })
      .expect(200);

    expect(connector.store.settings.logLimit).toBeLessThanOrEqual(5_000);
  });
});

describe("request body limits", () => {
  it("rejects an oversized body rather than buffering it", async () => {
    const huge = TINY_PNG_BASE64.repeat(200_000); // well over the limit
    const res = await request(connector.app)
      .post("/api/settings")
      .set("Authorization", `Bearer ${connector.token}`)
      .send({ blob: huge });

    expect(res.status).toBe(413);
  });
});
