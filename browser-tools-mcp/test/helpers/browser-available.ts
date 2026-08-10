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
}

let cached: BrowserAvailability | null = null;

export async function browserAvailability(): Promise<BrowserAvailability> {
  if (cached) return cached;
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    cached = { usable: true, reason: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    cached = {
      usable: false,
      reason:
        `Chromium could not be launched here, so the browser-dependent tests were skipped: ${message}. ` +
        `On macOS an ad hoc-signed Playwright build is sometimes refused; ` +
        `try: codesign --force --deep --sign - "$(node -p "require('playwright').chromium.executablePath()" | sed 's|/Contents/MacOS/.*||')" ` +
        `or reinstall with: npx playwright install --force chromium`,
    };
  }
  return cached;
}
