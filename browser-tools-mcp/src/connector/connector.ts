import express, { type Express, type Request, type Response, type NextFunction } from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { Duplex } from "node:stream";

import { TelemetryStore } from "./store.js";
import { localOnlyGuard, requireToken, isExtensionOrigin, isLoopbackHost } from "./security.js";
import { generateToken, tokensMatch } from "../util/session.js";
import { createLogger } from "../util/logger.js";
import {
  getDefaultScreenshotDir,
  resolveSafeScreenshotPath,
  screenshotFilename,
  UnsafePathError,
} from "../util/paths.js";
import { AuditError, runLighthouseAudit } from "../lighthouse/runner.js";
import { isAuditCategory, type AuditCategory, type AuditReport } from "../lighthouse/types.js";

export const SERVER_SIGNATURE = "mcp-browser-connector-24x7";
export const SERVER_VERSION = "2.0.0";

const log = createLogger("connector");

export class NoExtensionError extends Error {
  constructor() {
    super(
      "No browser extension is connected. Open Chrome DevTools (F12) on the page you want to inspect; " +
        "capture starts as soon as DevTools is open. Run `browser-tools-mcp --doctor` to check the setup."
    );
    this.name = "NoExtensionError";
  }
}

export class ExtensionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionRequestError";
  }
}

export class ExtensionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionTimeoutError";
  }
}

export interface ConnectorConfig {
  /** Loopback address to bind. Non-loopback requires allowNonLoopback. */
  host?: string;
  /** 0 picks an ephemeral port; otherwise the first free port from here. */
  port?: number;
  token?: string;
  screenshotDir?: string;
  redact?: boolean;
  heartbeatIntervalMs?: number;
  requestTimeoutMs?: number;
  maxBodySize?: string;
  /** Escape hatch, off by default, for users who knowingly expose the server. */
  allowNonLoopback?: boolean;
  /** Injectable so audits can be exercised without launching a browser. */
  auditRunner?: (options: { url: string; category: AuditCategory }) => Promise<AuditReport>;
}

export interface Connector {
  app: Express;
  server: http.Server;
  store: TelemetryStore;
  port: number;
  host: string;
  token: string;
  screenshotDir: string;
  hasExtension(): boolean;
  captureScreenshot(options?: { name?: string }): Promise<{ path: string; data: string; name: string }>;
  refreshTab(): Promise<void>;
  readStorage(kinds: string[]): Promise<Record<string, unknown>>;
  runAudit(category: AuditCategory, options?: { url?: string }): Promise<AuditReport>;
  close(): Promise<void>;
}

interface ExtensionConnection {
  ws: WebSocket;
  id: string;
  awaitingPong: boolean;
  missedPings: number;
  lastSeen: number;
  tabId: number | string | null;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export async function createConnector(config: ConnectorConfig = {}): Promise<Connector> {
  const host = config.host ?? "127.0.0.1";
  if (!isLoopbackHost(host) && !config.allowNonLoopback) {
    throw new Error(
      `Refusing to bind ${host}: the connector accepts loopback addresses only. ` +
        `Everything it exposes — console logs, network bodies, screenshots — would ` +
        `otherwise be reachable from the local network. Set allowNonLoopback to override.`
    );
  }

  const token = config.token ?? generateToken();
  const screenshotDir = path.resolve(config.screenshotDir ?? getDefaultScreenshotDir());
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? 15_000;
  const requestTimeoutMs = config.requestTimeoutMs ?? 10_000;

  const store = new TelemetryStore({ redact: config.redact !== false });

  const connections = new Map<string, ExtensionConnection>();
  const pending = new Map<string, PendingRequest>();
  let activeConnectionId: string | null = null;

  // ------------------------------------------------------------- http app

  const app = express();
  app.disable("x-powered-by");
  // Deliberately no cors() — the connector is same-machine only, and a
  // wildcard CORS policy is what let any visited page read captured telemetry.
  app.use(localOnlyGuard());
  app.use(express.json({ limit: config.maxBodySize ?? "10mb" }));

  app.get("/.identity", (_req: Request, res: Response) => {
    res.json({
      name: "BrowserTools Connector",
      version: SERVER_VERSION,
      signature: SERVER_SIGNATURE,
      port: actualPort,
      extensionConnected: connections.size > 0,
    });
  });

  const api = express.Router();
  api.use(requireToken(token));

  api.get("/settings", (_req, res) => {
    res.json({ settings: store.settings });
  });

  api.post("/settings", (req, res) => {
    const settings = store.updateSettings(req.body);
    broadcast({ type: "settings", settings });
    res.json({ settings });
  });

  api.get("/console", (req, res) => {
    res.json(
      store.queryConsole({
        errorsOnly: parseBool(req.query["errorsOnly"]) ?? false,
        keywords: parseList(req.query["keywords"]),
        limit: parseCount(req.query["limit"]),
        offset: parseCount(req.query["offset"]),
      })
    );
  });

  api.get("/network", (req, res) => {
    res.json(
      store.queryNetwork({
        errorsOnly: parseBool(req.query["errorsOnly"]) ?? false,
        urlKeywords: parseList(req.query["urlKeywords"]),
        bodyKeywords: parseList(req.query["bodyKeywords"]),
        limit: parseCount(req.query["limit"]),
        offset: parseCount(req.query["offset"]),
      })
    );
  });

  api.get("/selected-element", (_req, res) => {
    res.json({ element: store.getSelectedElement() });
  });

  api.get("/page", (_req, res) => {
    res.json({ ...store.getCurrentPage(), extensionConnected: connections.size > 0 });
  });

  api.get("/status", (_req, res) => {
    res.json({
      version: SERVER_VERSION,
      extensionConnected: connections.size > 0,
      connections: connections.size,
      screenshotDir,
      settings: store.settings,
      counts: {
        console: store.queryConsole({}).total,
        network: store.queryNetwork({}).total,
      },
    });
  });

  api.post("/wipe", (_req, res) => {
    store.wipe();
    res.json({ ok: true });
  });

  api.post("/screenshot", async (req: Request, res: Response) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : undefined;
      const result = await captureScreenshot(name ? { name } : {});
      res.json(result);
    } catch (error) {
      respondWithError(res, error);
    }
  });

  api.post("/refresh", async (_req: Request, res: Response) => {
    try {
      await refreshTab();
      res.json({ ok: true });
    } catch (error) {
      respondWithError(res, error);
    }
  });

  api.post("/storage", async (req: Request, res: Response) => {
    try {
      const kinds = parseList(req.body?.kinds) ?? ["localStorage", "sessionStorage"];
      const storage = await readStorage(kinds);
      res.json({ storage });
    } catch (error) {
      respondWithError(res, error);
    }
  });

  api.post("/audit/:category", async (req: Request, res: Response) => {
    const category = String(req.params["category"] ?? "");
    if (!isAuditCategory(category)) {
      res.status(400).json({ error: `Unknown audit category: ${category}`, code: "BAD_CATEGORY" });
      return;
    }
    try {
      const url = typeof req.body?.url === "string" ? req.body.url : undefined;
      res.json(await runAudit(category, url ? { url } : {}));
    } catch (error) {
      respondWithError(res, error);
    }
  });

  app.use("/api", api);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = Number(err?.status ?? err?.statusCode ?? 500);
    if (status === 413) {
      res.status(413).json({ error: "Request body too large", code: "PAYLOAD_TOO_LARGE" });
      return;
    }
    log.error("Unhandled request error:", err);
    res.status(Number.isFinite(status) ? status : 500).json({
      error: err?.message ?? "Internal error",
    });
  });

  // ---------------------------------------------------------- http server

  const server = http.createServer(app);
  server.on("error", (error) => log.error("HTTP server error:", error));

  const wss = new WebSocketServer({ noServer: true });
  wss.on("error", (error) => log.error("WebSocket server error:", error));

  server.on("upgrade", (req, socket: Duplex, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    if (url.pathname !== "/extension-ws") {
      return rejectUpgrade(socket, 404, "Not found");
    }

    const origin = req.headers.origin;
    if (origin) {
      // A browser sets Origin itself, so a page origin here means a web page is
      // trying to impersonate the extension.
      if (!isExtensionOrigin(origin)) {
        log.warn(`Rejected websocket upgrade from origin ${origin}`);
        return rejectUpgrade(socket, 403, "Forbidden origin");
      }
    } else {
      // No Origin means a non-browser client; it must prove it knows the token.
      const presented = url.searchParams.get("token") ?? "";
      if (!presented || !tokensMatch(presented, token)) {
        return rejectUpgrade(socket, 401, "Unauthorized");
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    const id = crypto.randomUUID();
    const connection: ExtensionConnection = {
      ws,
      id,
      awaitingPong: false,
      missedPings: 0,
      lastSeen: Date.now(),
      tabId: null,
    };
    connections.set(id, connection);
    activeConnectionId = id;
    log.info(`Extension connected (${connections.size} active)`);

    // Without this the process used to die on any socket-level error.
    ws.on("error", (error) => {
      log.warn("Extension socket error:", error);
      dropConnection(id);
    });

    ws.on("close", () => dropConnection(id));

    ws.on("message", (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        log.warn("Discarded unparseable websocket frame");
        return;
      }
      try {
        handleExtensionMessage(connection, message);
      } catch (error) {
        log.warn("Error handling extension message:", error);
      }
    });

    send(ws, { type: "welcome", settings: store.settings, serverVersion: SERVER_VERSION });
  });

  const heartbeat = setInterval(() => {
    for (const connection of connections.values()) {
      if (connection.awaitingPong) {
        connection.missedPings += 1;
        if (connection.missedPings >= 2) {
          log.warn("Extension stopped responding to pings; dropping it");
          try {
            connection.ws.terminate();
          } catch {
            /* already gone */
          }
          dropConnection(connection.id);
          continue;
        }
      }
      connection.awaitingPong = true;
      send(connection.ws, { type: "ping", id: crypto.randomUUID() });
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  // -------------------------------------------------------------- helpers

  function dropConnection(id: string): void {
    const connection = connections.get(id);
    if (!connection) return;
    connections.delete(id);
    if (activeConnectionId === id) {
      // Fall back to whichever connection is still open rather than leaving a
      // dangling pointer, which used to break capture with two DevTools windows.
      const next = [...connections.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0];
      activeConnectionId = next?.id ?? null;
    }
    log.info(`Extension disconnected (${connections.size} active)`);
  }

  function handleExtensionMessage(
    connection: ExtensionConnection,
    message: Record<string, unknown>
  ): void {
    connection.lastSeen = Date.now();
    const type = typeof message["type"] === "string" ? (message["type"] as string) : "";

    switch (type) {
      case "hello": {
        const tabId = message["tabId"];
        if (typeof tabId === "number" || typeof tabId === "string") connection.tabId = tabId;
        activeConnectionId = connection.id;
        break;
      }
      case "pong":
        connection.awaitingPong = false;
        connection.missedPings = 0;
        break;
      case "console":
        for (const entry of asEntries(message)) store.addConsole(entry);
        break;
      case "network":
        for (const entry of asEntries(message)) store.addNetwork(entry);
        break;
      case "selected-element":
        store.setSelectedElement(message["element"]);
        break;
      case "page":
        activeConnectionId = connection.id;
        store.setCurrentPage({ url: message["url"], tabId: message["tabId"] });
        break;
      case "settings":
        store.updateSettings(message["settings"]);
        break;
      case "screenshot-result":
      case "refresh-result":
      case "storage-result":
        resolvePending(message);
        break;
      default:
        log.debug(`Ignoring unknown message type: ${type || "(none)"}`);
    }
  }

  function resolvePending(message: Record<string, unknown>): void {
    const requestId = typeof message["requestId"] === "string" ? message["requestId"] : "";
    const entry = pending.get(requestId);
    if (!entry) {
      log.debug("Received a response for an unknown or expired request");
      return;
    }
    pending.delete(requestId);
    clearTimeout(entry.timer);

    if (message["ok"] === false) {
      const reason = typeof message["error"] === "string" ? message["error"] : "Extension reported a failure";
      entry.reject(new ExtensionRequestError(reason));
      return;
    }
    entry.resolve(message);
  }

  /** Sends a request to the extension and waits for the matching requestId. */
  function requestFromExtension(
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const connection =
      (activeConnectionId ? connections.get(activeConnectionId) : undefined) ??
      [...connections.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0];

    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new NoExtensionError());
    }

    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new ExtensionTimeoutError(`The extension did not answer ${type} in time`));
      }, requestTimeoutMs);
      timer.unref?.();

      pending.set(requestId, { resolve, reject, timer });
      send(connection.ws, { type, requestId, ...payload });
    });
  }

  async function captureScreenshot(
    options: { name?: string } = {}
  ): Promise<{ path: string; data: string; name: string }> {
    // Validate the destination before involving the browser at all, so a bad
    // name can never reach the filesystem.
    const filename = options.name ?? screenshotFilename();
    const destination = resolveSafeScreenshotPath(screenshotDir, filename);

    const response = await requestFromExtension("capture-screenshot", { name: filename });
    const data = typeof response["data"] === "string" ? response["data"] : "";
    const base64 = data.replace(/^data:image\/[a-zA-Z+]+;base64,/, "");
    if (!base64) throw new ExtensionRequestError("The extension returned an empty screenshot");

    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, Buffer.from(base64, "base64"));

    return { path: destination, data: `data:image/png;base64,${base64}`, name: filename };
  }

  async function refreshTab(): Promise<void> {
    await requestFromExtension("refresh-tab");
  }

  async function readStorage(kinds: string[]): Promise<Record<string, unknown>> {
    const response = await requestFromExtension("get-storage", { kinds });
    const storage = response["storage"];
    return storage && typeof storage === "object" ? (storage as Record<string, unknown>) : {};
  }

  /**
   * Audits whatever page the browser is on, unless a url is given.
   *
   * The old implementation polled an internal variable for 25 seconds waiting
   * for a url that nothing ever set; if the page is unknown, say so at once.
   */
  async function runAudit(
    category: AuditCategory,
    options: { url?: string } = {}
  ): Promise<AuditReport> {
    const url = options.url || store.getCurrentPage().url;
    if (!url) {
      throw new AuditError(
        "No page URL is known yet. Open the page in Chrome with DevTools open, or pass a url explicitly."
      );
    }
    const runner = config.auditRunner ?? runLighthouseAudit;
    return runner({ url, category });
  }

  function broadcast(message: unknown): void {
    for (const connection of connections.values()) send(connection.ws, message);
  }

  // --------------------------------------------------------------- listen

  const actualPortHolder = { value: 0 };
  await listen(server, host, config.port ?? 3025).then((p) => (actualPortHolder.value = p));
  const actualPort = actualPortHolder.value;

  log.info(`Connector listening on http://${host}:${actualPort}`);

  async function close(): Promise<void> {
    clearInterval(heartbeat);
    for (const { timer, reject } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("Connector shutting down"));
    }
    pending.clear();

    for (const connection of connections.values()) {
      try {
        connection.ws.terminate();
      } catch {
        /* already gone */
      }
    }
    connections.clear();

    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return {
    app,
    server,
    store,
    port: actualPort,
    host,
    token,
    screenshotDir,
    hasExtension: () => connections.size > 0,
    captureScreenshot,
    refreshTab,
    readStorage,
    runAudit,
    close,
  };
}

// ---------------------------------------------------------------- utilities

function respondWithError(res: Response, error: unknown): void {
  if (error instanceof AuditError) {
    res.status(422).json({ error: error.message, code: "AUDIT_FAILED" });
    return;
  }
  if (error instanceof UnsafePathError) {
    res.status(400).json({ error: error.message, code: "UNSAFE_PATH" });
    return;
  }
  if (error instanceof NoExtensionError) {
    res.status(503).json({ error: error.message, code: "NO_EXTENSION" });
    return;
  }
  if (error instanceof ExtensionTimeoutError) {
    res.status(504).json({ error: error.message, code: "EXTENSION_TIMEOUT" });
    return;
  }
  if (error instanceof ExtensionRequestError) {
    res.status(502).json({ error: error.message, code: "EXTENSION_ERROR" });
    return;
  }
  log.error("Unexpected error:", error);
  res.status(500).json({ error: (error as Error)?.message ?? "Internal error" });
}

function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (error) {
    log.warn("Failed to send to extension:", error);
  }
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  } catch {
    /* socket already gone */
  }
}

function asEntries(message: Record<string, unknown>): unknown[] {
  const entries = message["entries"];
  if (Array.isArray(entries)) return entries;
  if (message["entry"] !== undefined) return [message["entry"]];
  return [];
}

function parseBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (["true", "1", "yes"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no"].includes(value.toLowerCase())) return false;
  return undefined;
}

function parseCount(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === "string");
    return items.length ? items : undefined;
  }
  if (typeof value === "string" && value.length > 0) {
    const items = value.split(",").map((s) => s.trim()).filter(Boolean);
    return items.length ? items : undefined;
  }
  return undefined;
}

/** Binds the requested port, walking forward if it is taken. */
function listen(server: http.Server, host: string, startPort: number, attempts = 11): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = startPort;
    let remaining = attempts;

    const tryListen = () => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && remaining > 1 && startPort !== 0) {
          remaining -= 1;
          port += 1;
          setImmediate(tryListen);
          return;
        }
        reject(error);
      };

      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    };

    tryListen();
  });
}
