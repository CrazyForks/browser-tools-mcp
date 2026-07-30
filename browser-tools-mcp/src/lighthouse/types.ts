export const AUDIT_CATEGORIES = [
  "accessibility",
  "performance",
  "seo",
  "best-practices",
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export function isAuditCategory(value: string): value is AuditCategory {
  return (AUDIT_CATEGORIES as readonly string[]).includes(value);
}

export type ImpactLevel = "critical" | "serious" | "moderate" | "minor";

/**
 * The parts of a Lighthouse result this project reads. Declared structurally
 * rather than imported so the extractor can be unit-tested without Lighthouse.
 */
export interface LighthouseAuditLike {
  id?: string;
  title?: string;
  description?: string;
  score: number | null;
  scoreDisplayMode?: string;
  numericValue?: number;
  numericUnit?: string;
  displayValue?: string;
  details?: { type?: string; items?: unknown[]; [key: string]: unknown };
}

export interface LighthouseCategoryLike {
  id?: string;
  title?: string;
  score: number | null;
  auditRefs?: Array<{ id: string; weight?: number; group?: string }>;
}

export interface LighthouseResultLike {
  lighthouseVersion?: string;
  fetchTime?: string;
  requestedUrl?: string;
  finalDisplayedUrl?: string;
  categories?: Record<string, LighthouseCategoryLike>;
  audits?: Record<string, LighthouseAuditLike>;
}

export interface AuditIssueDetails {
  type?: string;
  items: unknown[];
  /** How many items were dropped to keep the report small. */
  omittedItems: number;
}

export interface AuditIssue {
  id: string;
  title: string;
  description: string;
  score: number | null;
  weight: number;
  impact: ImpactLevel;
  displayValue?: string;
  details?: AuditIssueDetails;
}

export interface AuditMetric {
  value: number;
  score: number | null;
  displayValue?: string;
  unit?: string;
}

export interface AuditReport {
  category: string;
  metadata: {
    url: string;
    timestamp: string;
    device: string;
    lighthouseVersion: string;
  };
  /** 0-100, or null when the category is missing from the result. */
  score: number | null;
  summary: {
    failed: number;
    passed: number;
    manual: number;
    informative: number;
    notApplicable: number;
  };
  issues: AuditIssue[];
  groups?: Record<string, { issues: number }>;
  metrics?: Record<string, AuditMetric>;
}
