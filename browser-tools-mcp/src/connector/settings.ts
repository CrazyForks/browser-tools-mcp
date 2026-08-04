/**
 * Capture settings the browser extension is allowed to change.
 *
 * This is an explicit allowlist with clamped ranges. The previous
 * implementation spread an arbitrary request body over its global settings
 * object, which let any caller repoint the screenshot directory or set an
 * unbounded log limit and exhaust memory.
 */

export interface CaptureSettings {
  /** Maximum entries retained per log category. */
  logLimit: number;
  /** Character budget for a single query response. */
  queryLimit: number;
  /** Maximum length of any individual captured string. */
  stringSizeLimit: number;
  /** Maximum serialised size of a single captured entry. */
  maxLogSize: number;
  /**
   * Byte budget for a screenshot. The browser degrades format and scale until
   * the capture fits, so an image never blows the client's context window or
   * overruns the transport's read buffer.
   */
  screenshotMaxBytes: number;
  showRequestHeaders: boolean;
  showResponseHeaders: boolean;
}

export const LIMITS = {
  logLimit: { min: 1, max: 5_000, default: 50 },
  queryLimit: { min: 1_000, max: 500_000, default: 30_000 },
  stringSizeLimit: { min: 100, max: 100_000, default: 500 },
  maxLogSize: { min: 1_000, max: 1_000_000, default: 20_000 },
  // Ceiling stays under the 10 MB read buffer that newer MCP stdio transports
  // enforce, so a screenshot can never sever the connection.
  screenshotMaxBytes: { min: 50_000, max: 9_000_000, default: 3_000_000 },
} as const;

export const DEFAULT_SETTINGS: Readonly<CaptureSettings> = Object.freeze({
  logLimit: LIMITS.logLimit.default,
  queryLimit: LIMITS.queryLimit.default,
  stringSizeLimit: LIMITS.stringSizeLimit.default,
  maxLogSize: LIMITS.maxLogSize.default,
  screenshotMaxBytes: LIMITS.screenshotMaxBytes.default,
  // Headers routinely carry credentials, so both default to off.
  showRequestHeaders: false,
  showResponseHeaders: false,
});

const NUMERIC_KEYS = [
  "logLimit",
  "queryLimit",
  "stringSizeLimit",
  "maxLogSize",
  "screenshotMaxBytes",
] as const satisfies readonly (keyof typeof LIMITS)[];

const BOOLEAN_KEYS = ["showRequestHeaders", "showResponseHeaders"] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Produces a new settings object from `current` plus whatever of `patch` is
 * recognised. Unknown keys, wrong types and out-of-range values are discarded
 * rather than rejected, so a well-meaning client with a stale field still works.
 */
export function mergeSettings(
  current: Readonly<CaptureSettings>,
  patch: unknown
): CaptureSettings {
  const out: CaptureSettings = { ...current };
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return out;

  const source = patch as Record<string, unknown>;

  for (const key of NUMERIC_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const range = LIMITS[key];
    out[key] = clamp(value, range.min, range.max);
  }

  for (const key of BOOLEAN_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (typeof value !== "boolean") continue;
    out[key] = value;
  }

  return out;
}
