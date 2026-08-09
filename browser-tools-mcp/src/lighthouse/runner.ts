import { createLogger } from "../util/logger.js";
import { extractAuditReport } from "./extract.js";
import { findAuditBrowser, NoBrowserError } from "./find-browser.js";
import type { AuditCategory, AuditReport, LighthouseResultLike } from "./types.js";

const log = createLogger("lighthouse");

export interface AuditHooks {
  /** Receives the unabridged Lighthouse result, for persisting as an artifact. */
  onRawResult?: (lhr: unknown) => void;
}

export interface AuditOptions {
  url: string;
  category: AuditCategory;
  /** "desktop" (default) or "mobile". */
  device?: "desktop" | "mobile";
  timeoutMs?: number;
}

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditError";
  }
}

/** Only real web pages can be audited; anything else is a configuration mistake. */
export function assertAuditableUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AuditError(`Not a valid URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AuditError(
      `Cannot audit ${parsed.protocol} URLs — navigate to an http(s) page first.`
    );
  }
  return parsed;
}

const CHROME_FLAGS = [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--mute-audio",
];

/**
 * Runs Lighthouse against a freshly launched headless Chrome.
 *
 * Chrome and Lighthouse are imported lazily so that a partial install degrades
 * to "audits unavailable" instead of preventing the whole server from starting.
 */
export async function runLighthouseAudit(
  options: AuditOptions,
  hooks: AuditHooks = {}
): Promise<AuditReport> {
  const { category, device = "desktop", timeoutMs = 60_000 } = options;
  const url = assertAuditableUrl(options.url).toString();

  let chrome: { port: number; kill: () => Promise<void> } | undefined;

  try {
    const [chromeLauncher, lighthouseModule] = await Promise.all([
      import("chrome-launcher"),
      import("lighthouse"),
    ]);
    const lighthouse = (lighthouseModule.default ?? lighthouseModule) as any;

    // chrome-launcher only knows about Chrome and Chromium. Anyone running Arc,
    // Brave or Edge with no Chrome installed would otherwise lose every audit.
    const browser = findAuditBrowser({
      installed: () => (chromeLauncher as any).Launcher?.getInstallations?.() ?? [],
    });
    log.debug(`Running the audit in ${browser.name} (${browser.source})`);

    chrome = (await chromeLauncher.launch({
      chromeFlags: CHROME_FLAGS,
      chromePath: browser.path,
    })) as unknown as { port: number; kill: () => Promise<void> };

    const flags = {
      port: chrome.port,
      output: "json" as const,
      logLevel: "error" as const,
      onlyCategories: [category],
      formFactor: device,
      screenEmulation:
        device === "desktop"
          ? { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false }
          : { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
      maxWaitForLoad: timeoutMs,
    };

    const result = (await withTimeout(
      lighthouse(url, flags),
      timeoutMs + 15_000,
      `Lighthouse did not finish within ${Math.round((timeoutMs + 15_000) / 1000)}s`
    )) as { lhr?: LighthouseResultLike } | undefined;

    const lhr = result?.lhr;
    if (!lhr) throw new AuditError("Lighthouse returned no result");

    hooks.onRawResult?.(lhr);
    return extractAuditReport(lhr, url, category);
  } catch (error) {
    if (error instanceof AuditError) throw error;
    // Already a clear, actionable explanation; do not bury it.
    if (error instanceof NoBrowserError) throw new AuditError(error.message);
    const message = error instanceof Error ? error.message : String(error);
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(message)) {
      throw new AuditError(
        "Lighthouse or Chrome is not available in this install, so audits cannot run."
      );
    }
    if (/No Chrome installations found|ChromePathNotSet/i.test(message)) {
      throw new AuditError(
        "No Chromium-based browser could be launched for the audit. Set CHROME_PATH to the " +
          "executable of a browser you have installed."
      );
    }
    throw new AuditError(`${category} audit failed: ${message}`);
  } finally {
    if (chrome) {
      try {
        await chrome.kill();
      } catch (error) {
        log.warn("Could not shut down the audit Chrome instance:", error);
      }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AuditError(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
