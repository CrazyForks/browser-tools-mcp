import type { NetworkEntry } from "../connector/store.js";

/**
 * Builds an HTTP Archive (HAR 1.2) from captured network entries.
 *
 * Exposed as a resource rather than inlined in a tool result: a full HAR of a
 * real page is far larger than an agent should ever be handed unasked, but it
 * is exactly what you want when a request needs to be examined properly, and
 * every browser and HTTP tool can already read the format.
 *
 * Values arrive already redacted; this does not scrub or unscrub anything.
 */

const CREATOR = { name: "BrowserTools MCP", version: "2.0.0" };

interface NameValue {
  name: string;
  value: string;
}

function headerList(headers: Record<string, string> | undefined): NameValue[] {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value ?? "") }));
}

function queryString(url: string): NameValue[] {
  try {
    const parsed = new URL(url);
    return [...parsed.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    // Relative or malformed urls simply have no parseable query.
    return [];
  }
}

function mimeTypeOf(headers: Record<string, string> | undefined): string {
  if (!headers) return "";
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "content-type") return String(value).split(";")[0]!.trim();
  }
  return "";
}

/**
 * HAR wants when the request started; the capture stamps when it finished.
 *
 * `startedAt` is recorded at capture where the DevTools API supplies it.
 * Falling back to finish-minus-duration is right for everything that reports a
 * duration, and an entry with neither can only report what it has.
 */
function startedDateTime(entry: NetworkEntry): string {
  const finished =
    Number.isFinite(entry.timestamp) && entry.timestamp > 0 ? entry.timestamp : Date.now();

  let ms = finished;
  if (Number.isFinite(entry.startedAt) && (entry.startedAt as number) > 0) {
    ms = entry.startedAt as number;
  } else if (Number.isFinite(entry.durationMs) && (entry.durationMs as number) > 0) {
    ms = finished - (entry.durationMs as number);
  }

  return new Date(ms).toISOString();
}

export function buildHar(entries: readonly NetworkEntry[]): Record<string, unknown> {
  return {
    log: {
      version: "1.2",
      creator: CREATOR,
      pages: [],
      entries: entries.map((entry) => {
        const time = Number.isFinite(entry.durationMs) ? Number(entry.durationMs) : 0;
        const responseBody = entry.responseBody ?? "";

        const request: Record<string, unknown> = {
          method: entry.method || "GET",
          url: entry.url || "",
          httpVersion: "HTTP/1.1",
          headers: headerList(entry.requestHeaders),
          queryString: queryString(entry.url || ""),
          cookies: [],
          headersSize: -1,
          bodySize: entry.requestBody ? entry.requestBody.length : 0,
        };
        if (entry.requestBody) {
          request["postData"] = {
            mimeType: mimeTypeOf(entry.requestHeaders) || "application/octet-stream",
            text: entry.requestBody,
          };
        }

        return {
          startedDateTime: startedDateTime(entry),
          time,
          request,
          response: {
            status: entry.status ?? 0,
            statusText: entry.error ? String(entry.error) : "",
            httpVersion: "HTTP/1.1",
            headers: headerList(entry.responseHeaders),
            cookies: [],
            content: {
              size: responseBody.length,
              mimeType: mimeTypeOf(entry.responseHeaders),
              ...(responseBody ? { text: responseBody } : {}),
            },
            redirectURL: "",
            headersSize: -1,
            bodySize: responseBody.length,
          },
          cache: {},
          // The capture only knows a total duration, so it is all attributed to
          // wait rather than invented across the phases.
          timings: { send: 0, wait: time, receive: 0 },
        };
      }),
    },
  };
}
