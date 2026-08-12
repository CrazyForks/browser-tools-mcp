import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  LIMITS,
} from "../../src/connector/settings";

describe("mergeSettings", () => {
  it("applies known keys", () => {
    const out = mergeSettings(DEFAULT_SETTINGS, {
      logLimit: 100,
      showRequestHeaders: true,
    });
    expect(out.logLimit).toBe(100);
    expect(out.showRequestHeaders).toBe(true);
  });

  // P0 regression: the old code did `currentSettings = {...currentSettings, ...settings}`
  // with settings taken straight from an unauthenticated request body, which let a
  // caller repoint screenshotPath or blow up memory via logLimit.
  it("drops unknown keys entirely", () => {
    const out = mergeSettings(DEFAULT_SETTINGS, {
      screenshotPath: "/etc",
      serverHost: "0.0.0.0",
      __proto__: { polluted: true },
      anythingElse: 1,
    } as any);

    expect(out).not.toHaveProperty("screenshotPath");
    expect(out).not.toHaveProperty("serverHost");
    expect(out).not.toHaveProperty("anythingElse");
    expect((({}) as any).polluted).toBeUndefined();
  });

  it("clamps numeric limits to sane maxima", () => {
    const out = mergeSettings(DEFAULT_SETTINGS, {
      logLimit: 1e9,
      queryLimit: 1e9,
      stringSizeLimit: 1e9,
    });
    expect(out.logLimit).toBe(LIMITS.logLimit.max);
    expect(out.queryLimit).toBe(LIMITS.queryLimit.max);
    expect(out.stringSizeLimit).toBe(LIMITS.stringSizeLimit.max);
  });

  it("clamps to minima and rejects negatives", () => {
    const out = mergeSettings(DEFAULT_SETTINGS, {
      logLimit: -5,
      queryLimit: 0,
    });
    expect(out.logLimit).toBe(LIMITS.logLimit.min);
    expect(out.queryLimit).toBe(LIMITS.queryLimit.min);
  });

  it("ignores values of the wrong type instead of throwing", () => {
    const out = mergeSettings(DEFAULT_SETTINGS, {
      logLimit: "lots" as any,
      showRequestHeaders: "yes" as any,
    });
    expect(out.logLimit).toBe(DEFAULT_SETTINGS.logLimit);
    expect(out.showRequestHeaders).toBe(DEFAULT_SETTINGS.showRequestHeaders);
  });

  it("does not mutate the input settings", () => {
    const before = { ...DEFAULT_SETTINGS };
    mergeSettings(DEFAULT_SETTINGS, { logLimit: 999 });
    expect(DEFAULT_SETTINGS).toEqual(before);
  });

  it("handles null/undefined patches", () => {
    expect(mergeSettings(DEFAULT_SETTINGS, undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, null as any)).toEqual(DEFAULT_SETTINGS);
  });

  it("defaults are conservative about headers", () => {
    // Headers frequently carry credentials; both toggles must default off.
    expect(DEFAULT_SETTINGS.showRequestHeaders).toBe(false);
    expect(DEFAULT_SETTINGS.showResponseHeaders).toBe(false);
  });
});

/**
 * 50 entries per category per tab is less than one real page load, which
 * silently clipped anything that reads back over a session.
 */
describe("retention default", () => {
  it("retains enough of a page load to be useful", () => {
    expect(LIMITS.logLimit.default).toBeGreaterThanOrEqual(500);
    expect(LIMITS.logLimit.default).toBeLessThanOrEqual(LIMITS.logLimit.max);
  });
});
