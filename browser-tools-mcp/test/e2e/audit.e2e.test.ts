import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";

import { runLighthouseAudit, AuditError, assertAuditableUrl } from "../../src/lighthouse/runner";
import { startFixtureServer, type FixtureServer } from "../fixtures/server";

/**
 * Actually runs Lighthouse.
 *
 * The extractor is unit-tested against a fixture, but that proves nothing about
 * whether Chrome launches, whether the Lighthouse flags are still valid for the
 * installed version, or whether a real result has the shape the extractor
 * expects. Four of the fifteen tools depend on this path.
 */

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await startFixtureServer();

  // chrome-launcher looks for a system Chrome. In CI, and on a machine without
  // Chrome installed, point it at the browser Playwright already downloaded.
  if (!process.env["CHROME_PATH"]) {
    process.env["CHROME_PATH"] = chromium.executablePath();
  }
}, 120_000);

afterAll(async () => {
  await fixture?.close();
});

describe("lighthouse audits against a real page", () => {
  it("runs an accessibility audit and returns a usable report", async () => {
    const report = await runLighthouseAudit({
      url: fixture.url,
      category: "accessibility",
    });

    expect(report.category).toBe("accessibility");
    expect(report.metadata.url).toContain("127.0.0.1");
    expect(report.metadata.lighthouseVersion).toMatch(/^\d+\./);

    // A real score, not a placeholder.
    expect(report.score).toBeTypeOf("number");
    expect(report.score!).toBeGreaterThanOrEqual(0);
    expect(report.score!).toBeLessThanOrEqual(100);

    // The fixture page has an image with no alt text, so there is something to find.
    const total =
      report.summary.failed + report.summary.passed + report.summary.notApplicable;
    expect(total).toBeGreaterThan(0);

    for (const issue of report.issues) {
      expect(issue.id).toBeTruthy();
      expect(issue.title).toBeTruthy();
      expect(["critical", "serious", "moderate", "minor"]).toContain(issue.impact);
    }
  }, 180_000);

  it("finds the missing alt attribute on the fixture page", async () => {
    const report = await runLighthouseAudit({ url: fixture.url, category: "accessibility" });
    const ids = report.issues.map((issue) => issue.id);
    expect(ids).toContain("image-alt");
  }, 180_000);

  it("runs a performance audit and reports core web vitals", async () => {
    const report = await runLighthouseAudit({ url: fixture.url, category: "performance" });

    expect(report.category).toBe("performance");
    expect(report.metrics).toBeDefined();
    // Whatever else varies, LCP and FCP are always measured for a real page.
    expect(Object.keys(report.metrics!)).toEqual(
      expect.arrayContaining(["first-contentful-paint", "largest-contentful-paint"])
    );
    expect(report.metrics!["largest-contentful-paint"]!.value).toBeGreaterThan(0);
  }, 240_000);

  it("runs an SEO audit", async () => {
    const report = await runLighthouseAudit({ url: fixture.url, category: "seo" });
    expect(report.category).toBe("seo");
    expect(report.score).toBeTypeOf("number");
  }, 180_000);

  it("runs a best-practices audit", async () => {
    const report = await runLighthouseAudit({ url: fixture.url, category: "best-practices" });
    expect(report.category).toBe("best-practices");
    expect(report.score).toBeTypeOf("number");
  }, 180_000);

  it("keeps a real report small enough to hand to a model", async () => {
    const report = await runLighthouseAudit({ url: fixture.url, category: "accessibility" });
    // A raw Lighthouse result is megabytes; the whole point of the extractor is
    // that what reaches the agent is not.
    expect(JSON.stringify(report).length).toBeLessThan(150_000);
  }, 180_000);

  it("fails clearly on a URL that cannot be audited", async () => {
    await expect(
      runLighthouseAudit({ url: "chrome://settings", category: "seo" })
    ).rejects.toThrow(AuditError);

    expect(() => assertAuditableUrl("not a url")).toThrow(AuditError);
    expect(() => assertAuditableUrl("file:///etc/passwd")).toThrow(AuditError);
  }, 60_000);

  it("reports a helpful error when Chrome cannot be found", async () => {
    const previous = process.env["CHROME_PATH"];
    process.env["CHROME_PATH"] = "/nonexistent/chrome-binary";
    try {
      await expect(
        runLighthouseAudit({ url: fixture.url, category: "seo" })
      ).rejects.toThrow(AuditError);
    } finally {
      process.env["CHROME_PATH"] = previous;
    }
  }, 120_000);
});
