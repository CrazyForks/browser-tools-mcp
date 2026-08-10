import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../util/logger.js";

const log = createLogger("browser");

/**
 * Locates a browser to run Lighthouse audits in.
 *
 * `chrome-launcher` only looks for Google Chrome and Chromium. Plenty of people
 * run Arc, Brave or Edge and have no Chrome at all — for them every audit
 * failed with "No Chrome installations found", losing four of the fifteen tools
 * with no hint that a different browser would do.
 *
 * Any Chromium-based browser can serve, since Lighthouse only needs a DevTools
 * protocol endpoint. Preference runs from closest-to-stock outwards, because
 * the more a fork customises its UI the likelier a headless run is to surprise.
 */

export class NoBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoBrowserError";
  }
}

export interface BrowserCandidate {
  name: string;
  path: string;
}

export interface FoundBrowser extends BrowserCandidate {
  /** How it was located, for diagnostics. */
  source: "CHROME_PATH" | "chrome-launcher" | "known-install";
}

const APPS = "/Applications";

/**
 * Chromium forks worth trying, best first. Ordering matters: a stock-ish build
 * behaves most predictably under Lighthouse, and Arc customises the most.
 */
export const CHROMIUM_CANDIDATES: readonly BrowserCandidate[] = [
  // Stock Chrome first. chrome-launcher should normally find this, but it
  // locates browsers through Spotlight on macOS, which is not always available
  // — restricted environments, indexing turned off, or an install too recent to
  // have been indexed. Without this entry a freshly installed Chrome was passed
  // over in favour of a stale cached build.
  { name: "Google Chrome", path: `${APPS}/Google Chrome.app/Contents/MacOS/Google Chrome` },
  { name: "Chromium", path: `${APPS}/Chromium.app/Contents/MacOS/Chromium` },
  { name: "Google Chrome Canary", path: `${APPS}/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary` },
  { name: "Brave", path: `${APPS}/Brave Browser.app/Contents/MacOS/Brave Browser` },
  { name: "Microsoft Edge", path: `${APPS}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` },
  { name: "Vivaldi", path: `${APPS}/Vivaldi.app/Contents/MacOS/Vivaldi` },
  { name: "Opera", path: `${APPS}/Opera.app/Contents/MacOS/Opera` },
  // Linux locations, for the same browsers.
  { name: "Google Chrome", path: "/usr/bin/google-chrome" },
  { name: "Google Chrome", path: "/usr/bin/google-chrome-stable" },
  { name: "Chromium", path: "/usr/bin/chromium" },
  { name: "Chromium", path: "/usr/bin/chromium-browser" },
  { name: "Brave", path: "/usr/bin/brave-browser" },
  { name: "Microsoft Edge", path: "/usr/bin/microsoft-edge" },
  // Windows, since the project claims to support it.
  { name: "Google Chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  { name: "Google Chrome", path: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" },
  { name: "Microsoft Edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
];

/**
 * Tried only once everything else is exhausted.
 *
 * Arc replaces much of Chromium's window and tab handling, so it is the most
 * likely to behave unexpectedly headless. It is still far better than failing
 * outright for someone who has nothing else installed.
 */
export const LAST_RESORT_CANDIDATES: readonly BrowserCandidate[] = [
  { name: "Arc", path: `${APPS}/Arc.app/Contents/MacOS/Arc` },
];

export interface FindOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
  /** chrome-launcher's own detection, injected so this stays testable. */
  installed?: () => string[];
  /** Additional paths to consider before the known forks. */
  extraCandidates?: BrowserCandidate[];
}

function defaultExists(candidate: string): boolean {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

/**
 * A Chrome for Testing build downloaded by Playwright, if one is present.
 *
 * Worth preferring over a fork: it is a real Chrome build, and anyone who has
 * run the end-to-end suite already has one.
 */
function playwrightChromium(exists: (p: string) => boolean): BrowserCandidate[] {
  const root = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  const found: BrowserCandidate[] = [];
  try {
    // Highest build number first; readdir order is arbitrary and an old build
    // is likelier to be stale or broken.
    const dirs = fs
      .readdirSync(root)
      .filter((d) => d.startsWith("chromium-"))
      .sort((a, b) => Number(b.split("-")[1] ?? 0) - Number(a.split("-")[1] ?? 0));
    for (const dir of dirs) {
      for (const variant of ["chrome-mac-arm64", "chrome-mac", "chrome-linux"]) {
        for (const leaf of [
          "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "chrome",
        ]) {
          const candidate = path.join(root, dir, variant, leaf);
          if (exists(candidate)) found.push({ name: "Chrome for Testing", path: candidate });
        }
      }
    }
  } catch {
    /* no playwright cache, which is entirely normal */
  }
  return found;
}

export function findAuditBrowser(options: FindOptions = {}): FoundBrowser {
  const env = options.env ?? process.env;
  const exists = options.exists ?? defaultExists;

  const explicit = env["CHROME_PATH"];
  if (explicit) {
    if (exists(explicit)) {
      return { name: "CHROME_PATH", path: explicit, source: "CHROME_PATH" };
    }
    // Falling back beats failing when a working browser is installed, but doing
    // it silently would leave someone puzzling over why their setting had no
    // effect.
    log.warn(
      `CHROME_PATH points at ${explicit}, which does not exist. Looking for another browser instead.`
    );
  }

  // chrome-launcher first: if real Chrome is installed, use it.
  try {
    for (const candidate of options.installed?.() ?? []) {
      if (exists(candidate)) {
        return { name: "Google Chrome", path: candidate, source: "chrome-launcher" };
      }
    }
  } catch {
    /* its detection is best-effort; the fallbacks below still apply */
  }

  // Installed browsers before cached test builds: a Chrome the user maintains
  // is likelier to work, and to be current, than one a tool downloaded once.
  // Installed, stock-like browsers first; then a cached Chrome for Testing,
  // which is a real Chrome build but may be stale; then the heavily customised
  // ones, which are better than nothing but likeliest to surprise.
  const fallbacks = [
    ...CHROMIUM_CANDIDATES,
    ...(options.extraCandidates ?? []),
    ...playwrightChromium(exists),
    ...LAST_RESORT_CANDIDATES,
  ];
  for (const candidate of fallbacks) {
    if (exists(candidate.path)) {
      return { ...candidate, source: "known-install" };
    }
  }

  throw new NoBrowserError(
    "Audits need a Chromium-based browser to run in, and none was found. " +
      "Looked for Google Chrome, Chromium, Brave, Microsoft Edge, Vivaldi, Opera and Arc. " +
      "Install one, or set CHROME_PATH to the executable of a Chromium-based browser you " +
      "already have — for example: " +
      `CHROME_PATH="${APPS}/Arc.app/Contents/MacOS/Arc". ` +
      "Everything else (console, network, screenshots) works without this."
  );
}

/**
 * Explains a browser that was found but would not start.
 *
 * Lighthouse reports this as a bare "connect ECONNREFUSED <port>", because from
 * its side the debugging port simply never opened. That tells a user nothing.
 */
export function describeLaunchFailure(browser: FoundBrowser, cause: string): string {
  const parts = [
    `Found ${browser.name} at ${browser.path}, but it would not start, so the audit could not run.`,
    `Underlying error: ${cause}`,
  ];

  if (browser.path.includes("ms-playwright")) {
    // Playwright's Chromium is ad-hoc signed, and some macOS installs abort it
    // on launch with no output at all.
    parts.push(
      "This is a Chromium downloaded by Playwright, which is ad-hoc signed and is " +
        "sometimes refused by macOS. Re-signing it often helps: " +
        `codesign --force --deep --sign - "${browser.path.replace(/\/Contents\/MacOS\/.*$/, "")}"`
    );
  }

  parts.push(
    "Otherwise set CHROME_PATH to a Chromium-based browser that does start, or install " +
      "Google Chrome. Console, network and screenshot capture are unaffected."
  );
  return parts.join(" ");
}
