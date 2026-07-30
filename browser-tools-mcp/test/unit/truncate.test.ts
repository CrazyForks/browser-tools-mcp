import { describe, it, expect } from "vitest";
import {
  truncateStringsInData,
  selectLogsWithinBudget,
} from "../../src/util/truncate";

describe("truncateStringsInData", () => {
  it("truncates long strings and marks them", () => {
    const out = truncateStringsInData("x".repeat(100), 10) as string;
    expect(out.startsWith("x".repeat(10))).toBe(true);
    expect(out).toContain("truncated");
  });

  it("leaves short strings untouched", () => {
    expect(truncateStringsInData("short", 10)).toBe("short");
  });

  it("recurses through arrays and objects", () => {
    const out = truncateStringsInData(
      { a: ["y".repeat(50)], b: { c: "z".repeat(50) } },
      5
    ) as any;
    expect(out.a[0]).toContain("truncated");
    expect(out.b.c).toContain("truncated");
  });

  it("preserves non-string primitives", () => {
    const out = truncateStringsInData({ n: 42, b: false, nil: null }, 5) as any;
    expect(out).toEqual({ n: 42, b: false, nil: null });
  });

  it("survives circular references", () => {
    const a: any = { s: "hello" };
    a.self = a;
    expect(() => truncateStringsInData(a, 2)).not.toThrow();
  });
});

describe("selectLogsWithinBudget", () => {
  const entry = (id: number, size: number) => ({
    id,
    payload: "x".repeat(size),
  });

  it("returns the NEWEST logs when the budget is tight, not the oldest", () => {
    // Regression test for the original bug: the old implementation iterated
    // oldest-first and returned the least relevant entries.
    const logs = [entry(1, 100), entry(2, 100), entry(3, 100)];
    const out = selectLogsWithinBudget(logs, 250);

    const ids = out.map((l: any) => l.id);
    expect(ids).toContain(3);
    expect(ids).not.toContain(1);
  });

  it("returns results in chronological order", () => {
    const logs = [entry(1, 10), entry(2, 10), entry(3, 10)];
    const out = selectLogsWithinBudget(logs, 10_000);
    expect(out.map((l: any) => l.id)).toEqual([1, 2, 3]);
  });

  it("does not let one oversized entry starve everything after it", () => {
    // Regression test: the old implementation `break`ed on the first entry that
    // exceeded the budget, so a single huge early log hid every later one.
    const logs = [entry(1, 100_000), entry(2, 10), entry(3, 10)];
    const out = selectLogsWithinBudget(logs, 1000);

    const ids = out.map((l: any) => l.id);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
  });

  it("returns at least one (truncated) entry when even the newest exceeds budget", () => {
    const logs = [entry(1, 100_000)];
    const out = selectLogsWithinBudget(logs, 500);
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out).length).toBeLessThan(5000);
  });

  it("returns everything when the budget is generous", () => {
    const logs = [entry(1, 10), entry(2, 10)];
    expect(selectLogsWithinBudget(logs, 1_000_000)).toHaveLength(2);
  });

  it("handles an empty list", () => {
    expect(selectLogsWithinBudget([], 100)).toEqual([]);
  });

  it("never exceeds the budget by more than one truncated entry", () => {
    const logs = Array.from({ length: 50 }, (_, i) => entry(i, 200));
    const out = selectLogsWithinBudget(logs, 2000);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(2000 * 1.5);
  });
});
