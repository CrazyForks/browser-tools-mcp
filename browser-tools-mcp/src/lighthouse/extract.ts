import { truncateStringsInData } from "../util/truncate.js";
import type {
  AuditIssue,
  AuditMetric,
  AuditReport,
  ImpactLevel,
  LighthouseAuditLike,
  LighthouseResultLike,
} from "./types.js";

/**
 * How many detail items to keep per issue, by impact.
 *
 * A raw Lighthouse result is megabytes; an agent needs the failures and enough
 * examples to act on them. Critical issues keep everything because that is
 * what the user is going to fix first.
 */
export const DETAIL_LIMITS: Record<ImpactLevel, number> = {
  critical: Number.MAX_SAFE_INTEGER,
  serious: 15,
  moderate: 10,
  minor: 3,
};

/** A failing score by Lighthouse's own convention. */
const PASS_THRESHOLD = 0.9;

/** Longest string kept inside a detail item. */
const DETAIL_STRING_LIMIT = 300;

/** Metrics worth surfacing separately from the pass/fail issue list. */
const CORE_METRIC_IDS = new Set([
  "first-contentful-paint",
  "largest-contentful-paint",
  "cumulative-layout-shift",
  "total-blocking-time",
  "speed-index",
  "interactive",
  "interaction-to-next-paint",
  "server-response-time",
]);

function impactFor(score: number | null, weight: number): ImpactLevel {
  if (score === 0) return "critical";
  if (score !== null && score <= 0.5) return "serious";
  if (weight >= 3) return "moderate";
  return "minor";
}

function extractDetails(
  audit: LighthouseAuditLike,
  impact: ImpactLevel
): AuditIssue["details"] {
  const items = audit.details?.items;
  if (!Array.isArray(items) || items.length === 0) return undefined;

  const limit = DETAIL_LIMITS[impact];
  const kept = items.slice(0, limit === Number.MAX_SAFE_INTEGER ? items.length : limit);

  const details: AuditIssue["details"] = {
    items: truncateStringsInData(kept, DETAIL_STRING_LIMIT) as unknown[],
    omittedItems: items.length - kept.length,
  };
  if (audit.details?.type) details.type = audit.details.type;
  return details;
}

/**
 * Reshapes a Lighthouse result into something an agent can read: the failures,
 * ordered by weight, with bounded supporting detail.
 */
export function extractAuditReport(
  lhr: LighthouseResultLike,
  url: string,
  category: string,
  device: string = "desktop"
): AuditReport {
  const categoryData = lhr.categories?.[category];
  const audits = lhr.audits ?? {};
  const auditRefs = categoryData?.auditRefs ?? [];

  const summary = {
    failed: 0,
    passed: 0,
    manual: 0,
    informative: 0,
    notApplicable: 0,
  };
  const groups: Record<string, { issues: number }> = {};
  const issues: AuditIssue[] = [];
  const metrics: Record<string, AuditMetric> = {};

  for (const ref of auditRefs) {
    const audit = audits[ref.id];
    if (!audit) continue;

    const weight = ref.weight ?? 0;

    switch (audit.scoreDisplayMode) {
      case "manual":
        summary.manual += 1;
        continue;
      case "informative":
        summary.informative += 1;
        continue;
      case "notApplicable":
        summary.notApplicable += 1;
        continue;
      default:
        break;
    }

    if (audit.score === null) continue;

    const failing = audit.score < PASS_THRESHOLD;
    if (failing) summary.failed += 1;
    else summary.passed += 1;

    if (ref.group) {
      groups[ref.group] ??= { issues: 0 };
      if (failing) groups[ref.group]!.issues += 1;
    }

    if (CORE_METRIC_IDS.has(ref.id) && typeof audit.numericValue === "number") {
      const metric: AuditMetric = { value: audit.numericValue, score: audit.score };
      if (audit.displayValue) metric.displayValue = audit.displayValue;
      if (audit.numericUnit) metric.unit = audit.numericUnit;
      metrics[ref.id] = metric;
    }

    if (!failing) continue;

    const impact = impactFor(audit.score, weight);
    const issue: AuditIssue = {
      id: ref.id,
      title: audit.title ?? ref.id,
      description: audit.description ?? "",
      score: audit.score,
      weight,
      impact,
    };
    if (audit.displayValue) issue.displayValue = audit.displayValue;

    const details = extractDetails(audit, impact);
    if (details) issue.details = details;

    issues.push(issue);
  }

  issues.sort((a, b) => b.weight - a.weight);

  const report: AuditReport = {
    category,
    metadata: {
      url: url || lhr.finalDisplayedUrl || lhr.requestedUrl || "",
      timestamp: lhr.fetchTime ?? new Date().toISOString(),
      device,
      lighthouseVersion: lhr.lighthouseVersion ?? "unknown",
    },
    score:
      typeof categoryData?.score === "number" ? Math.round(categoryData.score * 100) : null,
    summary,
    issues,
  };

  if (Object.keys(groups).length > 0) report.groups = groups;
  if (Object.keys(metrics).length > 0) report.metrics = metrics;

  return report;
}
