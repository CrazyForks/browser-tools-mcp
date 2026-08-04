/**
 * Image payload handling for screenshots.
 *
 * Screenshots travel as base64 and end up inlined in an MCP tool result. On a
 * high-DPI display a full-viewport capture of a visually dense page runs to
 * tens of megabytes, which is far past what any client wants in its context and
 * past the 10 MB read buffer newer MCP stdio transports enforce. So the format
 * is negotiable, and the size is measured rather than assumed.
 */

export const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg"]);

export interface ParsedImage {
  mimeType: string;
  base64: string;
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/**
 * Reads a data URL into its mime type and payload. A bare base64 string is
 * treated as PNG, which is what the extension has always produced, so a client
 * that omits the prefix does not silently write a corrupt file.
 */
export function parseImageDataUrl(value: string): ParsedImage | null {
  if (typeof value !== "string" || value.length === 0) return null;

  const match = DATA_URL.exec(value);
  if (!match) {
    // No prefix at all: assume the historical PNG payload.
    return value.startsWith("data:") ? null : { mimeType: "image/png", base64: value };
  }

  const mimeType = (match[1] ?? "").toLowerCase();
  const base64 = match[2] ?? "";
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) || base64.length === 0) return null;

  return { mimeType, base64 };
}

export function extensionForMimeType(mimeType: string): string {
  return mimeType === "image/jpeg" ? "jpg" : "png";
}

/** Forces a filename's extension to match the bytes actually being written. */
export function withExtension(name: string, extension: string): string {
  const slash = name.lastIndexOf("/");
  const dir = slash === -1 ? "" : name.slice(0, slash + 1);
  const base = slash === -1 ? name : name.slice(slash + 1);

  const dot = base.lastIndexOf(".");
  const stem = dot <= 0 ? base : base.slice(0, dot);

  return `${dir}${stem}.${extension}`;
}

/** Decoded size of a base64 payload, without decoding it. */
export function approximateBytes(base64: string): number {
  if (!base64) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
