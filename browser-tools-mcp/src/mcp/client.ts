import type { Connector } from "../connector/connector.js";
import type {
  ConsoleEntry,
  ConsoleQuery,
  NetworkEntry,
  NetworkQuery,
  QueryResult,
} from "../connector/store.js";
import type { AuditCategory, AuditReport } from "../lighthouse/types.js";

export interface PageInfo {
  url: string;
  tabId: number | string | null;
  extensionConnected: boolean;
}

export interface ConnectorStatus {
  version: string;
  extensionConnected: boolean;
  connections: number;
  screenshotDir: string;
  counts: { console: number; network: number };
}

export interface ScreenshotResult {
  path: string;
  data: string;
  name: string;
}

/**
 * The operations the MCP tools need. Implemented both in-process (the normal
 * single-process setup) and over HTTP (when attaching to a connector that is
 * already running for another client).
 */
export interface ConnectorClient {
  console(query: ConsoleQuery): Promise<QueryResult<ConsoleEntry>>;
  network(query: NetworkQuery): Promise<QueryResult<NetworkEntry>>;
  selectedElement(): Promise<unknown>;
  page(): Promise<PageInfo>;
  status(): Promise<ConnectorStatus>;
  wipe(): Promise<void>;
  screenshot(options: { name?: string }): Promise<ScreenshotResult>;
  refresh(): Promise<void>;
  storage(kinds: string[]): Promise<Record<string, unknown>>;
  audit(category: AuditCategory, options?: { url?: string }): Promise<AuditReport>;
}

/** Talks straight to an embedded connector — no network hop, no discovery. */
export class InProcessConnectorClient implements ConnectorClient {
  #connector: Connector;

  constructor(connector: Connector) {
    this.#connector = connector;
  }

  async console(query: ConsoleQuery): Promise<QueryResult<ConsoleEntry>> {
    return this.#connector.store.queryConsole(query);
  }

  async network(query: NetworkQuery): Promise<QueryResult<NetworkEntry>> {
    return this.#connector.store.queryNetwork(query);
  }

  async selectedElement(): Promise<unknown> {
    return this.#connector.store.getSelectedElement();
  }

  async page(): Promise<PageInfo> {
    return {
      ...this.#connector.store.getCurrentPage(),
      extensionConnected: this.#connector.hasExtension(),
    };
  }

  async status(): Promise<ConnectorStatus> {
    return {
      version: "2.0.0",
      extensionConnected: this.#connector.hasExtension(),
      connections: this.#connector.hasExtension() ? 1 : 0,
      screenshotDir: this.#connector.screenshotDir,
      counts: {
        console: this.#connector.store.queryConsole({}).total,
        network: this.#connector.store.queryNetwork({}).total,
      },
    };
  }

  async wipe(): Promise<void> {
    this.#connector.store.wipe();
  }

  async screenshot(options: { name?: string }): Promise<ScreenshotResult> {
    return this.#connector.captureScreenshot(options);
  }

  async refresh(): Promise<void> {
    return this.#connector.refreshTab();
  }

  async storage(kinds: string[]): Promise<Record<string, unknown>> {
    return this.#connector.readStorage(kinds);
  }

  async audit(category: AuditCategory, options: { url?: string } = {}): Promise<AuditReport> {
    return this.#connector.runAudit(category, options);
  }
}

export interface HttpConnectorClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/** Talks to a connector running in another process. */
export class HttpConnectorClient implements ConnectorClient {
  #baseUrl: string;
  #token: string;
  #fetch: typeof fetch;

  constructor(options: HttpConnectorClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async #request<T>(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}
  ): Promise<T> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.length) url.searchParams.set(key, value.join(","));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await this.#fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      const message =
        typeof payload["error"] === "string" ? payload["error"] : `Request failed (${response.status})`;
      throw new Error(message);
    }
    return payload as T;
  }

  console(query: ConsoleQuery): Promise<QueryResult<ConsoleEntry>> {
    return this.#request("/api/console", { query: query as Record<string, unknown> });
  }

  network(query: NetworkQuery): Promise<QueryResult<NetworkEntry>> {
    return this.#request("/api/network", { query: query as Record<string, unknown> });
  }

  async selectedElement(): Promise<unknown> {
    const result = await this.#request<{ element: unknown }>("/api/selected-element");
    return result.element;
  }

  page(): Promise<PageInfo> {
    return this.#request("/api/page");
  }

  status(): Promise<ConnectorStatus> {
    return this.#request("/api/status");
  }

  async wipe(): Promise<void> {
    await this.#request("/api/wipe", { method: "POST", body: {} });
  }

  screenshot(options: { name?: string }): Promise<ScreenshotResult> {
    return this.#request("/api/screenshot", { method: "POST", body: options });
  }

  async refresh(): Promise<void> {
    await this.#request("/api/refresh", { method: "POST", body: {} });
  }

  async storage(kinds: string[]): Promise<Record<string, unknown>> {
    const result = await this.#request<{ storage: Record<string, unknown> }>("/api/storage", {
      method: "POST",
      body: { kinds },
    });
    return result.storage;
  }

  audit(category: AuditCategory, options: { url?: string } = {}): Promise<AuditReport> {
    return this.#request(`/api/audit/${category}`, { method: "POST", body: options });
  }
}
