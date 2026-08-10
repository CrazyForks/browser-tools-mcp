import { describe, it, expect } from "vitest";
import {
  findAuditBrowser,
  CHROMIUM_CANDIDATES,
  NoBrowserError,
} from "../../src/lighthouse/find-browser";

/**
 * Audits launch their own browser through chrome-launcher, which only looks for
 * Google Chrome and Chromium. A developer running Arc, Brave or Edge — with no
 * Chrome installed at all — got "No Chrome installations found" and lost four
 * of the fifteen tools with no way to tell why.
 */

/** Builds a probe that reports only the given paths as present. */
const only = (...present: string[]) => (p: string) => present.includes(p);
const none = () => false;

describe("findAuditBrowser", () => {
  it("prefers an explicit CHROME_PATH above everything", () => {
    const found = findAuditBrowser({
      env: { CHROME_PATH: "/custom/my-chrome" },
      exists: only("/custom/my-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      installed: () => ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    });
    expect(found.path).toBe("/custom/my-chrome");
    expect(found.source).toBe("CHROME_PATH");
  });

  it("ignores a CHROME_PATH that does not exist, rather than failing outright", () => {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const found = findAuditBrowser({
      env: { CHROME_PATH: "/nonexistent/chrome" },
      exists: only(chrome),
      installed: () => [chrome],
    });
    expect(found.path).toBe(chrome);
  });

  it("uses a real Chrome install when there is one", () => {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const found = findAuditBrowser({ env: {}, exists: only(chrome), installed: () => [chrome] });

    expect(found.path).toBe(chrome);
    expect(found.source).toBe("chrome-launcher");
  });

  it("falls back to a Chromium-based browser when no Chrome exists", () => {
    // The reported case: Arc and nothing else.
    const arc = "/Applications/Arc.app/Contents/MacOS/Arc";
    const found = findAuditBrowser({ env: {}, exists: only(arc), installed: () => [] });

    expect(found.path).toBe(arc);
    expect(found.name).toBe("Arc");
  });

  it("prefers a Chrome for Testing build over a heavily forked browser", () => {
    const arc = "/Applications/Arc.app/Contents/MacOS/Arc";
    const testing = "/Users/x/Library/Caches/ms-playwright/chromium-1/chrome-mac/Google Chrome for Testing";
    const found = findAuditBrowser({
      env: {},
      exists: only(arc, testing),
      installed: () => [],
      extraCandidates: [{ name: "Chrome for Testing", path: testing }],
    });

    // Lighthouse is likeliest to behave on a build closest to stock Chrome.
    expect(found.path).toBe(testing);
  });

  it("prefers Brave over Arc when both are present", () => {
    const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
    const arc = "/Applications/Arc.app/Contents/MacOS/Arc";
    expect(findAuditBrowser({ env: {}, exists: only(brave, arc), installed: () => [] }).name).toBe(
      "Brave"
    );
  });

  it("covers the browsers people actually use", () => {
    const names = CHROMIUM_CANDIDATES.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["Brave", "Microsoft Edge", "Arc", "Vivaldi", "Opera"])
    );
  });

  it("survives chrome-launcher throwing", () => {
    const arc = "/Applications/Arc.app/Contents/MacOS/Arc";
    const found = findAuditBrowser({
      env: {},
      exists: only(arc),
      installed: () => {
        throw new Error("chrome-launcher blew up");
      },
    });
    expect(found.path).toBe(arc);
  });
});

describe("when there is no browser at all", () => {
  it("throws an error that says what to do", () => {
    let thrown: unknown;
    try {
      findAuditBrowser({ env: {}, exists: none, installed: () => [] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NoBrowserError);
    const message = (thrown as Error).message;

    // The old message named only Chrome, which is unhelpful to someone running
    // Arc who does not realise a second browser is needed.
    expect(message).toMatch(/CHROME_PATH/);
    expect(message).toMatch(/audit/i);
    expect(message.length).toBeGreaterThan(80);
  });

  it("names the browsers it looked for", () => {
    try {
      findAuditBrowser({ env: {}, exists: none, installed: () => [] });
    } catch (error) {
      expect((error as Error).message).toMatch(/Chrome|Brave|Arc/);
    }
  });
});

/**
 * A browser that exists but will not start is a distinct failure, and the one
 * users actually hit: Playwright's ad-hoc-signed Chromium aborts on some macOS
 * installs, and Lighthouse surfaced that as "connect ECONNREFUSED 127.0.0.1:57529",
 * which says nothing about what went wrong or what to do.
 */
describe("describeLaunchFailure", () => {
  it("names the browser that failed and suggests an alternative", async () => {
    const { describeLaunchFailure } = await import("../../src/lighthouse/find-browser");
    const message = describeLaunchFailure(
      { name: "Chrome for Testing", path: "/cache/x/Chrome", source: "known-install" },
      "connect ECONNREFUSED 127.0.0.1:57529"
    );

    expect(message).toContain("Chrome for Testing");
    expect(message).toContain("/cache/x/Chrome");
    expect(message).toMatch(/CHROME_PATH/);
    // The underlying error still has to be there for anyone debugging.
    expect(message).toContain("ECONNREFUSED");
  });

  it("mentions the macOS signing cause for a Playwright cache path", async () => {
    const { describeLaunchFailure } = await import("../../src/lighthouse/find-browser");
    const message = describeLaunchFailure(
      {
        name: "Chrome for Testing",
        path: "/Users/x/Library/Caches/ms-playwright/chromium-1/chrome-mac-arm64/Google Chrome for Testing",
        source: "known-install",
      },
      "connect ECONNREFUSED"
    );

    expect(message).toMatch(/sign|codesign/i);
  });

  it("stays brief for an ordinary browser", async () => {
    const { describeLaunchFailure } = await import("../../src/lighthouse/find-browser");
    const message = describeLaunchFailure(
      { name: "Brave", path: "/Applications/Brave Browser.app/x", source: "known-install" },
      "spawn EACCES"
    );

    expect(message).toContain("Brave");
    expect(message).not.toMatch(/codesign/i);
  });
});
