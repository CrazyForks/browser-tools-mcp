import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  { name: "Chromium", path: `${APPS}/Chromium.app/Contents/MacOS/Chromium` },
  { name: "Google Chrome Canary", path: `${APPS}/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary` },
  { name: "Brave", path: `${APPS}/Brave Browser.app/Contents/MacOS/Brave Browser` },
  { name: "Microsoft Edge", path: `${APPS}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` },
  { name: "Vivaldi", path: `${APPS}/Vivaldi.app/Contents/MacOS/Vivaldi` },
  { name: "Opera", path: `${APPS}/Opera.app/Contents/MacOS/Opera` },
  { name: "Arc", path: `${APPS}/Arc.app/Contents/MacOS/Arc` },
  // Linux locations, for the same browsers.
  { name: "Chromium", path: "/usr/bin/chromium" },
  { name: "Chromium", path: "/usr/bin/chromium-browser" },
  { name: "Google Chrome", path: "/usr/bin/google-chrome" },
  { name: "Brave", path: "/usr/bin/brave-browser" },
  { name: "Microsoft Edge", path: "/usr/bin/microsoft-edge" },
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
    for (const dir of fs.readdirSync(root)) {
      if (!dir.startsWith("chromium-")) continue;
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
  if (explicit && exists(explicit)) {
    return { name: "CHROME_PATH", path: explicit, source: "CHROME_PATH" };
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

  const fallbacks = [
    ...(options.extraCandidates ?? []),
    ...playwrightChromium(exists),
    ...CHROMIUM_CANDIDATES,
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
