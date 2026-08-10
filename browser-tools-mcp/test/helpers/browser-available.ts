import { chromium } from "playwright";

/**
 * Whether a browser can actually be launched here.
 *
 * Checked once, up front, so the browser-dependent suites can skip with an
 * explanation instead of failing. A machine that cannot start Chromium — an ad
 * hoc-signed build refused by macOS, a container with no display, a restricted
 * sandbox — says nothing about whether the code is correct, and a suite that
 * goes red for that reason teaches people to ignore red suites.
 */
export interface BrowserAvailability {
  usable: boolean;
  reason: string;
  /** Extra launch options the suites must pass to get a working browser. */
  launchOptions: { channel?: string };
}

let cached: BrowserAvailability | null = null;

export async function browserAvailability(): Promise<BrowserAvailability> {
  if (cached) return cached;

  // Playwright's own Chromium is ad hoc-signed and some macOS installs refuse
  // to start it, so an installed Chrome is tried as well before giving up.
  const attempts: Array<{ label: string; options: { channel?: string } }> = [
    { label: "bundled chromium", options: {} },
    { label: "installed Chrome", options: { channel: "chrome" } },
  ];

  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch({ headless: true, ...attempt.options });
      await browser.close();
      cached = { usable: true, reason: "", launchOptions: attempt.options };
      return cached;
    } catch (error) {
      const detail = error instanceof Error ? error.message.split("\n")[0]! : String(error);
      failures.push(`${attempt.label}: ${detail}`);
    }
  }

  {
    const message = failures.join("; ");
    cached = {
      usable: false,
      launchOptions: {},
      reason:
        `Chromium could not be launched here, so the browser-dependent tests were skipped: ${message}. ` +
        `On macOS an ad hoc-signed Playwright build is sometimes refused; ` +
        `try: codesign --force --deep --sign - "$(node -p "require('playwright').chromium.executablePath()" | sed 's|/Contents/MacOS/.*||')" ` +
        `or reinstall with: npx playwright install --force chromium`,
    };
  }
  return cached;
}
