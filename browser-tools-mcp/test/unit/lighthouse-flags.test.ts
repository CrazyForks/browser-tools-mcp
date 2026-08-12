import { describe, it, expect } from "vitest";
import { buildLighthouseFlags } from "../../src/lighthouse/runner";

/**
 * The audit's three device settings have to agree with each other.
 *
 * formFactor and screenEmulation were passed but throttling and
 * emulatedUserAgent were not, so a desktop audit ran a desktop viewport with
 * Lighthouse's default mobile Slow-4G throttling and a mobile user agent, then
 * reported itself as desktop.
 */
describe("buildLighthouseFlags", () => {
  it("throttles a desktop audit as desktop", async () => {
    const flags = await buildLighthouseFlags({ category: "performance", device: "desktop", port: 1, timeoutMs: 1000 });

    expect(flags.formFactor).toBe("desktop");
    expect(flags.screenEmulation.mobile).toBe(false);
    expect(flags.throttling.cpuSlowdownMultiplier).toBe(1);
  });

  it("throttles a mobile audit as mobile", async () => {
    const flags = await buildLighthouseFlags({ category: "performance", device: "mobile", port: 1, timeoutMs: 1000 });

    expect(flags.formFactor).toBe("mobile");
    expect(flags.screenEmulation.mobile).toBe(true);
    expect(flags.throttling.cpuSlowdownMultiplier).toBeGreaterThan(1);
  });

  it("sets a user agent matching the form factor", async () => {
    const desktop = await buildLighthouseFlags({ category: "seo", device: "desktop", port: 1, timeoutMs: 1000 });
    const mobile = await buildLighthouseFlags({ category: "seo", device: "mobile", port: 1, timeoutMs: 1000 });

    expect(desktop.emulatedUserAgent).toBeTruthy();
    expect(mobile.emulatedUserAgent).toBeTruthy();
    expect(desktop.emulatedUserAgent).not.toBe(mobile.emulatedUserAgent);
  });

  it("carries the category, port and timeout through", async () => {
    const flags = await buildLighthouseFlags({ category: "seo", device: "desktop", port: 9222, timeoutMs: 45_000 });

    expect(flags.onlyCategories).toEqual(["seo"]);
    expect(flags.port).toBe(9222);
    expect(flags.maxWaitForLoad).toBe(45_000);
  });
});
