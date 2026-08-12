import { describe, it, expect } from "vitest";
import { extractAuditReport, DETAIL_LIMITS } from "../../src/lighthouse/extract";
import type { LighthouseResultLike } from "../../src/lighthouse/types";

function auditRef(id: string, weight = 3, group?: string) {
  return group ? { id, weight, group } : { id, weight };
}

function makeLhr(overrides: Partial<LighthouseResultLike> = {}): LighthouseResultLike {
  return {
    lighthouseVersion: "13.4.1",
    fetchTime: "2026-07-30T10:00:00.000Z",
    requestedUrl: "https://example.com",
    finalDisplayedUrl: "https://example.com",
    categories: {
      accessibility: {
        id: "accessibility",
        title: "Accessibility",
        score: 0.72,
        auditRefs: [
          auditRef("color-contrast", 7, "a11y-color-contrast"),
          auditRef("image-alt", 5, "a11y-names-labels"),
          auditRef("label", 3, "a11y-names-labels"),
          auditRef("html-has-lang", 1),
          auditRef("passing-audit", 3),
          auditRef("manual-audit", 0),
          auditRef("informative-audit", 0),
          auditRef("na-audit", 0),
        ],
      },
    },
    audits: {
      "color-contrast": {
        id: "color-contrast",
        title: "Background and foreground colors have sufficient contrast",
        description: "Low-contrast text is difficult or impossible to read.",
        score: 0,
        scoreDisplayMode: "binary",
        details: {
          type: "table",
          items: Array.from({ length: 40 }, (_, i) => ({
            node: { selector: `.item-${i}`, snippet: `<div class="item-${i}">`, nodeLabel: `Item ${i}` },
            value: 2.1,
          })),
        },
      },
      "image-alt": {
        id: "image-alt",
        title: "Image elements have [alt] attributes",
        description: "Informative elements should aim for short, descriptive alternate text.",
        score: 0.4,
        scoreDisplayMode: "binary",
        details: {
          type: "table",
          items: Array.from({ length: 30 }, (_, i) => ({
            node: { selector: `img.pic-${i}`, snippet: `<img src="pic-${i}.png">` },
          })),
        },
      },
      label: {
        id: "label",
        title: "Form elements have associated labels",
        description: "Labels ensure that form controls are announced properly.",
        score: 0.8,
        scoreDisplayMode: "binary",
        details: {
          type: "table",
          items: Array.from({ length: 25 }, (_, i) => ({ node: { selector: `#field-${i}` } })),
        },
      },
      "html-has-lang": {
        id: "html-has-lang",
        title: "`<html>` element has a `[lang]` attribute",
        description: "Screen readers need the page language.",
        score: 0.8,
        scoreDisplayMode: "binary",
        details: { type: "table", items: Array.from({ length: 20 }, (_, i) => ({ index: i })) },
      },
      "passing-audit": {
        id: "passing-audit",
        title: "A passing audit",
        description: "This one is fine.",
        score: 1,
        scoreDisplayMode: "binary",
      },
      "manual-audit": {
        id: "manual-audit",
        title: "Needs manual check",
        description: "Check this yourself.",
        score: null,
        scoreDisplayMode: "manual",
      },
      "informative-audit": {
        id: "informative-audit",
        title: "Informative",
        description: "Just so you know.",
        score: null,
        scoreDisplayMode: "informative",
      },
      "na-audit": {
        id: "na-audit",
        title: "Not applicable",
        description: "Nothing to check here.",
        score: null,
        scoreDisplayMode: "notApplicable",
      },
    },
    ...overrides,
  } as LighthouseResultLike;
}

describe("extractAuditReport", () => {
  it("carries through metadata", () => {
    const report = extractAuditReport(makeLhr(), "https://example.com", "accessibility");

    expect(report.category).toBe("accessibility");
    expect(report.metadata.url).toBe("https://example.com");
    expect(report.metadata.lighthouseVersion).toBe("13.4.1");
    expect(report.metadata.timestamp).toBe("2026-07-30T10:00:00.000Z");
  });

  it("reports the overall category score", () => {
    const report = extractAuditReport(makeLhr(), "https://example.com", "accessibility");
    expect(report.score).toBe(72);
  });

  it("counts audits by outcome", () => {
    const report = extractAuditReport(makeLhr(), "https://example.com", "accessibility");

    expect(report.summary.failed).toBe(4);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.manual).toBe(1);
    expect(report.summary.informative).toBe(1);
    expect(report.summary.notApplicable).toBe(1);
  });

  it("returns only failing audits, heaviest first", () => {
    const report = extractAuditReport(makeLhr(), "https://example.com", "accessibility");

    expect(report.issues.map((i) => i.id)).toEqual([
      "color-contrast",
      "image-alt",
      "label",
      "html-has-lang",
    ]);
  });

  it("classifies impact from score and weight", () => {
    const report = extractAuditReport(makeLhr(), "https://example.com", "accessibility");
    const byId = new Map(report.issues.map((i) => [i.id, i]));

    expect(byId.get("color-contrast")!.impact).toBe("critical"); // score 0
    expect(byId.get("image-alt")!.impact).toBe("serious"); // score <= 0.5
    expect(byId.get("label")!.impact).toBe("moderate"); // failing, meaningful weight
    expect(byId.get("html-has-lang")!.impact).toBe("minor"); // failing, low weight
  });

  it("keeps every detail item for critical issues", () => {
    const report = extractAuditReport(makeLhr(), "https://example.com", "accessibility");
    const critical = report.issues.find((i) => i.id === "color-contrast")!;

    expect(critical.details?.items).toHaveLength(40);
    expect(critical.details?.omittedItems).toBe(0);
  });

  it("caps detail items for lower-impact issues and says how many it dropped", () => {
    const report = extractAuditReport(makeLhr(), "https://example.com", "accessibility");
    const byId = new Map(report.issues.map((i) => [i.id, i]));

    expect(byId.get("image-alt")!.details?.items).toHaveLength(DETAIL_LIMITS.serious);
    expect(byId.get("image-alt")!.details?.omittedItems).toBe(30 - DETAIL_LIMITS.serious);

    expect(byId.get("label")!.details?.items).toHaveLength(DETAIL_LIMITS.moderate);
    expect(byId.get("html-has-lang")!.details?.items).toHaveLength(DETAIL_LIMITS.minor);
  });

  it("produces a payload small enough for a context window", () => {
    const report = extractAuditReport(makeLhr(), "https://example.com", "accessibility");
    expect(JSON.stringify(report).length).toBeLessThan(30_000);
  });

  it("groups issue counts by audit group when present", () => {
    const report = extractAuditReport(makeLhr(), "https://example.com", "accessibility");
    expect(report.groups?.["a11y-names-labels"]?.issues).toBe(2);
  });
});

describe("extractAuditReport with performance results", () => {
  const performanceLhr = () =>
    makeLhr({
      categories: {
        performance: {
          id: "performance",
          title: "Performance",
          score: 0.45,
          auditRefs: [auditRef("largest-contentful-paint", 25), auditRef("unused-javascript", 5)],
        },
      },
      audits: {
        "largest-contentful-paint": {
          id: "largest-contentful-paint",
          title: "Largest Contentful Paint",
          description: "LCP marks the time the largest content element is rendered.",
          score: 0.3,
          scoreDisplayMode: "numeric",
          numericValue: 4200,
          numericUnit: "millisecond",
          displayValue: "4.2 s",
        },
        "unused-javascript": {
          id: "unused-javascript",
          title: "Reduce unused JavaScript",
          description: "Reduce unused JavaScript to lower bytes consumed.",
          score: 0.5,
          scoreDisplayMode: "numeric",
          numericValue: 350_000,
          displayValue: "Potential savings of 342 KiB",
          details: { type: "opportunity", items: [{ url: "https://example.com/app.js", wastedBytes: 350_000 }] },
        },
      },
    } as Partial<LighthouseResultLike>);

  it("surfaces core metrics with their display values", () => {
    const report = extractAuditReport(performanceLhr(), "https://example.com", "performance");

    expect(report.metrics?.["largest-contentful-paint"]).toMatchObject({
      value: 4200,
      displayValue: "4.2 s",
    });
  });

  it("still lists failing audits as issues", () => {
    const report = extractAuditReport(performanceLhr(), "https://example.com", "performance");
    expect(report.issues.map((i) => i.id)).toContain("unused-javascript");
  });
});

describe("extractAuditReport with degenerate input", () => {
  it("survives a result with no categories", () => {
    const report = extractAuditReport(
      { lighthouseVersion: "13.4.1" } as LighthouseResultLike,
      "https://example.com",
      "seo"
    );

    expect(report.score).toBeNull();
    expect(report.issues).toEqual([]);
    expect(report.summary.failed).toBe(0);
  });

  it("survives audit refs pointing at missing audits", () => {
    const lhr = makeLhr({
      categories: {
        seo: { id: "seo", title: "SEO", score: 1, auditRefs: [auditRef("does-not-exist")] },
      },
      audits: {},
    } as Partial<LighthouseResultLike>);

    expect(() => extractAuditReport(lhr, "https://example.com", "seo")).not.toThrow();
    expect(extractAuditReport(lhr, "https://example.com", "seo").issues).toEqual([]);
  });

  it("survives audits with no details", () => {
    const lhr = makeLhr({
      categories: {
        seo: { id: "seo", title: "SEO", score: 0.5, auditRefs: [auditRef("bare")] },
      },
      audits: {
        bare: { id: "bare", title: "Bare", description: "", score: 0, scoreDisplayMode: "binary" },
      },
    } as Partial<LighthouseResultLike>);

    const report = extractAuditReport(lhr, "https://example.com", "seo");
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.details).toBeUndefined();
  });

  it("falls back to the requested url when none is supplied", () => {
    const report = extractAuditReport(makeLhr(), "", "accessibility");
    expect(report.metadata.url).toBe("https://example.com");
  });
});

/**
 * The report must name the device it actually simulated.
 *
 * metadata.device was hardcoded to "desktop" regardless of what the audit ran
 * as, so a mobile audit reported desktop.
 */
describe("device metadata", () => {
  it("reports the device it was told the audit used", () => {
    const report = extractAuditReport(makeLhr(), "https://example.com", "performance", "mobile");
    expect(report.metadata.device).toBe("mobile");
  });

  it("still defaults to desktop when nothing is passed", () => {
    const report = extractAuditReport(makeLhr(), "https://example.com", "performance");
    expect(report.metadata.device).toBe("desktop");
  });
});
