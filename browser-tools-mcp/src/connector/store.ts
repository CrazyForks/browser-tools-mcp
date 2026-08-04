import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type CaptureSettings,
} from "./settings.js";
import { redactHeaders, redactSecretsInString, redactValue } from "../util/redact.js";
import { selectLogsWithinBudget, truncateStringsInData } from "../util/truncate.js";

export type TabId = number | string;

export interface ConsoleEntry {
  type: string;
  level: string;
  message: string;
  timestamp: number;
  /** The browser tab this came from, when known. */
  tabId?: TabId | null;
  url?: string;
  stackTrace?: unknown;
}

export interface NetworkEntry {
  type: string;
  url: string;
  method: string;
  status: number;
  timestamp: number;
  tabId?: TabId | null;
  durationMs?: number;
  error?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
}

export interface SelectedElement {
  [key: string]: unknown;
}

export interface PageState {
  url: string;
  tabId: TabId | null;
}

export interface QueryResult<T> {
  entries: T[];
  /** Entries matching the filter before pagination and budget clipping. */
  total: number;
  /** Entries actually returned. */
  returned: number;
  /** True when the caller is not seeing every matching entry. */
  truncated: boolean;
}

export interface ConsoleQuery {
  errorsOnly?: boolean;
  keywords?: string[];
  /** Restrict to one tab. Omit to read across every tab. */
  tabId?: TabId;
  limit?: number;
  offset?: number;
}

export interface NetworkQuery {
  errorsOnly?: boolean;
  urlKeywords?: string[];
  bodyKeywords?: string[];
  tabId?: TabId;
  limit?: number;
  offset?: number;
}

export interface TelemetryStoreOptions {
  settings?: Partial<CaptureSettings>;
  /** Set false to keep raw credentials in captured data. */
  redact?: boolean;
}

const ERROR_LEVELS = new Set(["error", "assert", "critical"]);

/** Entries with no tab attribution share one bucket. */
const UNATTRIBUTED = "__no-tab__";

function tabKey(tabId: TabId | null | undefined): string {
  return tabId === null || tabId === undefined ? UNATTRIBUTED : String(tabId);
}

/**
 * In-memory telemetry captured from the browser.
 *
 * Entries are attributed to the tab that produced them, because DevTools can be
 * open on several tabs at once and merging their output leaves an agent unable
 * to tell which page it is looking at. Retention is per tab too, so a noisy tab
 * cannot evict a quiet one's history.
 *
 * Everything is scrubbed and size-capped on the way in, so nothing downstream
 * has to remember to do it, and a hostile page cannot grow the process without
 * bound.
 */
export class TelemetryStore {
  #settings: CaptureSettings;
  #redact: boolean;
  #console: ConsoleEntry[] = [];
  #network: NetworkEntry[] = [];
  #selectedElements = new Map<string, SelectedElement>();
  #lastSelectedTab: string = UNATTRIBUTED;
  #page: PageState = { url: "", tabId: null };

  constructor(options: TelemetryStoreOptions = {}) {
    this.#settings = mergeSettings(DEFAULT_SETTINGS, options.settings);
    this.#redact = options.redact !== false;
  }

  get settings(): Readonly<CaptureSettings> {
    return this.#settings;
  }

  updateSettings(patch: unknown): CaptureSettings {
    this.#settings = mergeSettings(this.#settings, patch);
    this.#evictAll();
    return this.#settings;
  }

  // ---------------------------------------------------------------- ingest

  addConsole(raw: unknown, tabId?: TabId | null): ConsoleEntry | null {
    const source = asRecord(raw);
    if (!source) return null;

    const level = asString(source["level"]) || inferLevel(asString(source["type"]));
    const entry: ConsoleEntry = {
      type: asString(source["type"]) || "console-log",
      level,
      message: this.#clean(coerceMessage(source["message"])),
      timestamp: asTimestamp(source["timestamp"]),
      tabId: resolveTabId(tabId, source["tabId"]),
    };

    const url = asString(source["url"]);
    if (url) entry.url = this.#clean(url);

    if (source["stackTrace"] !== undefined) {
      entry.stackTrace = this.#cleanValue(source["stackTrace"]);
    }

    this.#console.push(entry);
    this.#evictTab(this.#console, tabKey(entry.tabId));
    return entry;
  }

  addNetwork(raw: unknown, tabId?: TabId | null): NetworkEntry | null {
    const source = asRecord(raw);
    if (!source) return null;

    const entry: NetworkEntry = {
      type: asString(source["type"]) || "network-request",
      url: this.#clean(asString(source["url"])),
      method: asString(source["method"]) || "GET",
      status: asNumber(source["status"]),
      timestamp: asTimestamp(source["timestamp"]),
      tabId: resolveTabId(tabId, source["tabId"]),
    };

    const duration = asNumber(source["durationMs"] ?? source["duration"]);
    if (duration) entry.durationMs = duration;

    const error = asString(source["error"]);
    if (error) entry.error = this.#clean(error);

    // Headers are stored redacted; whether they are handed out is a separate
    // decision made at query time.
    const requestHeaders = asRecord(source["requestHeaders"]);
    if (requestHeaders) {
      entry.requestHeaders = this.#headers(requestHeaders as Record<string, string>);
    }
    const responseHeaders = asRecord(source["responseHeaders"]);
    if (responseHeaders) {
      entry.responseHeaders = this.#headers(responseHeaders as Record<string, string>);
    }

    const requestBody = source["requestBody"];
    if (requestBody !== undefined && requestBody !== null) {
      entry.requestBody = this.#clean(coerceMessage(requestBody));
    }
    const responseBody = source["responseBody"];
    if (responseBody !== undefined && responseBody !== null) {
      entry.responseBody = this.#clean(coerceMessage(responseBody));
    }

    this.#network.push(entry);
    this.#evictTab(this.#network, tabKey(entry.tabId));
    return entry;
  }

  setSelectedElement(element: unknown, tabId?: TabId | null): void {
    const key = tabKey(tabId);
    const record = asRecord(element);
    if (!record) {
      this.#selectedElements.delete(key);
      return;
    }
    this.#selectedElements.set(key, this.#cleanValue(record) as SelectedElement);
    this.#lastSelectedTab = key;
  }

  /** The element selected in a given tab, or the most recent one overall. */
  getSelectedElement(tabId?: TabId | null): SelectedElement | null {
    const key = tabId === undefined ? this.#lastSelectedTab : tabKey(tabId);
    return this.#selectedElements.get(key) ?? null;
  }

  setCurrentPage(page: { url?: unknown; tabId?: unknown }): void {
    const url = asString(page?.url);
    if (url) this.#page.url = url;
    const tabId = page?.tabId;
    if (typeof tabId === "number" || typeof tabId === "string") {
      this.#page.tabId = tabId;
    }
  }

  getCurrentPage(): PageState {
    return { ...this.#page };
  }

  /** Clears one tab's telemetry, or everything when no tab is named. */
  wipe(tabId?: TabId | null): void {
    if (tabId === undefined || tabId === null) {
      this.#console = [];
      this.#network = [];
      this.#selectedElements.clear();
      this.#lastSelectedTab = UNATTRIBUTED;
      return;
    }

    const key = tabKey(tabId);
    this.#console = this.#console.filter((entry) => tabKey(entry.tabId) !== key);
    this.#network = this.#network.filter((entry) => tabKey(entry.tabId) !== key);
    this.#selectedElements.delete(key);
  }

  // ----------------------------------------------------------------- query

  queryConsole(query: ConsoleQuery): QueryResult<ConsoleEntry> {
    let matched = this.#console;

    if (query.tabId !== undefined) {
      const key = tabKey(query.tabId);
      matched = matched.filter((e) => tabKey(e.tabId) === key);
    }
    if (query.errorsOnly) {
      matched = matched.filter((e) => ERROR_LEVELS.has(e.level));
    }
    if (query.keywords?.length) {
      matched = matched.filter((e) => matchesAny([e.message], query.keywords!));
    }

    return this.#paginate(matched, query.limit, query.offset);
  }

  queryNetwork(query: NetworkQuery): QueryResult<NetworkEntry> {
    let matched = this.#network;

    if (query.tabId !== undefined) {
      const key = tabKey(query.tabId);
      matched = matched.filter((e) => tabKey(e.tabId) === key);
    }
    if (query.errorsOnly) {
      matched = matched.filter(isNetworkError);
    }
    if (query.urlKeywords?.length) {
      matched = matched.filter((e) => matchesAny([e.url], query.urlKeywords!));
    }
    if (query.bodyKeywords?.length) {
      matched = matched.filter((e) =>
        matchesAny([e.responseBody, e.requestBody], query.bodyKeywords!)
      );
    }

    const result = this.#paginate(matched, query.limit, query.offset);
    result.entries = result.entries.map((entry) => this.#applyHeaderVisibility(entry));
    return result;
  }

  /**
   * Every matching console entry, with no query budget applied.
   *
   * Used to back a resource, where the caller has explicitly asked for the
   * whole thing rather than a context-sized sample.
   */
  allConsole(tabId?: TabId): ConsoleEntry[] {
    if (tabId === undefined) return [...this.#console];
    const key = tabKey(tabId);
    return this.#console.filter((entry) => tabKey(entry.tabId) === key);
  }

  allNetwork(tabId?: TabId): NetworkEntry[] {
    const key = tabId === undefined ? null : tabKey(tabId);
    return this.#network
      .filter((entry) => key === null || tabKey(entry.tabId) === key)
      // Header visibility is a privacy setting, so it applies to exports too.
      .map((entry) => this.#applyHeaderVisibility(entry));
  }

  /** Tabs that have produced telemetry, newest activity first. */
  knownTabs(): TabId[] {
    const seen = new Map<string, TabId>();
    for (const entry of [...this.#console, ...this.#network]) {
      if (entry.tabId !== null && entry.tabId !== undefined) {
        seen.set(tabKey(entry.tabId), entry.tabId);
      }
    }
    return [...seen.values()];
  }

  // --------------------------------------------------------------- private

  #paginate<T>(matched: readonly T[], limit?: number, offset?: number): QueryResult<T> {
    const total = matched.length;

    let page: readonly T[] = matched;
    if (limit !== undefined || offset !== undefined) {
      const skip = Math.max(0, Math.floor(offset ?? 0));
      const take = Math.max(0, Math.floor(limit ?? total));
      const end = total - skip;
      page = end <= 0 ? [] : matched.slice(Math.max(0, end - take), end);
    }

    const entries = selectLogsWithinBudget(page, this.#settings.queryLimit);
    return {
      entries,
      total,
      returned: entries.length,
      truncated: entries.length < total,
    };
  }

  /** Headers are only handed out when the user has opted in. */
  #applyHeaderVisibility(entry: NetworkEntry): NetworkEntry {
    if (this.#settings.showRequestHeaders && this.#settings.showResponseHeaders) {
      return entry;
    }
    const out: NetworkEntry = { ...entry };
    if (!this.#settings.showRequestHeaders) delete out.requestHeaders;
    if (!this.#settings.showResponseHeaders) delete out.responseHeaders;
    return out;
  }

  /**
   * Trims one tab's entries to the log limit, walking newest-first so the
   * oldest go. Retention is per tab so a chatty page cannot push out the
   * history of a quiet one the user actually cares about.
   */
  #evictTab(list: Array<{ tabId?: TabId | null }>, key: string): void {
    const limit = this.#settings.logLimit;
    let seen = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (tabKey(list[i]?.tabId) !== key) continue;
      seen += 1;
      if (seen > limit) list.splice(i, 1);
    }
  }

  #evictAll(): void {
    for (const list of [this.#console, this.#network] as Array<
      Array<{ tabId?: TabId | null }>
    >) {
      const keys = new Set(list.map((entry) => tabKey(entry.tabId)));
      for (const key of keys) this.#evictTab(list, key);
    }
  }

  #headers(headers: Record<string, string>): Record<string, string> {
    const redacted = this.#redact ? redactHeaders(headers) : { ...headers };
    return truncateStringsInData(
      redacted,
      this.#settings.stringSizeLimit
    ) as Record<string, string>;
  }

  /**
   * Coarse-caps, scrubs, then truncates. Scrubbing happens before the final
   * truncation so a secret can never be split across the cut and survive.
   */
  #clean(value: string): string {
    if (!value) return value;
    const capped =
      value.length > this.#settings.maxLogSize
        ? value.slice(0, this.#settings.maxLogSize)
        : value;
    const scrubbed = this.#redact ? redactSecretsInString(capped) : capped;
    return truncateStringsInData(scrubbed, this.#settings.stringSizeLimit) as string;
  }

  #cleanValue(value: unknown): unknown {
    const scrubbed = this.#redact ? redactValue(value) : value;
    return truncateStringsInData(scrubbed, this.#settings.stringSizeLimit);
  }
}

// -------------------------------------------------------------- helpers

function resolveTabId(explicit: TabId | null | undefined, fromPayload: unknown): TabId | null {
  if (explicit !== undefined && explicit !== null) return explicit;
  if (typeof fromPayload === "number" || typeof fromPayload === "string") return fromPayload;
  return null;
}

function isNetworkError(entry: NetworkEntry): boolean {
  return Boolean(entry.error) || entry.status >= 400 || entry.status === 0;
}

/**
 * Substring match that tolerates absent or non-string fields — captured
 * entries frequently lack a body or a url.
 */
function matchesAny(fields: readonly unknown[], keywords: readonly string[]): boolean {
  const needles = keywords
    .filter((k): k is string => typeof k === "string" && k.length > 0)
    .map((k) => k.toLowerCase());
  if (needles.length === 0) return true;

  for (const field of fields) {
    if (typeof field !== "string" || field.length === 0) continue;
    const haystack = field.toLowerCase();
    if (needles.some((needle) => haystack.includes(needle))) return true;
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asTimestamp(value: unknown): number {
  const n = asNumber(value);
  if (n > 0) return n;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Console arguments arrive as strings, objects, or anything else. */
function coerceMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return "[unserialisable]";
    }
  }
  return String(value);
}

function inferLevel(type: string): string {
  if (type.includes("error")) return "error";
  if (type.includes("warn")) return "warning";
  if (type.includes("info")) return "info";
  return "log";
}
