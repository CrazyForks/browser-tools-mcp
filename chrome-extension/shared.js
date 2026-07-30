/* Shared helpers for the devtools page and the panel. */

// Firefox exposes the same APIs under `browser`; Chrome under `chrome`.
// eslint-disable-next-line no-var
var api = typeof globalThis.browser !== "undefined" ? globalThis.browser : globalThis.chrome;

const DEFAULT_SETTINGS = {
  serverHost: "127.0.0.1",
  serverPort: 3025,
  logLimit: 50,
  queryLimit: 30000,
  stringSizeLimit: 500,
  maxLogSize: 20000,
  showRequestHeaders: false,
  showResponseHeaders: false,
  captureConsole: true,
  captureNetwork: true,
  captureResponseBodies: true,
  /**
   * "debugger" uses the Chrome DevTools Protocol: richer output, but the
   * browser shows a "started debugging" banner. "inject" wraps the page's
   * console instead — no banner, and it is the only mode Firefox supports.
   */
  captureMode: "debugger",
};

/**
 * Ports the connector may be listening on.
 *
 * Loopback only, and deliberately so: earlier versions scanned private
 * network ranges and adopted whichever host answered, which let anyone on the
 * same network receive a developer's console output and screenshots.
 */
const DISCOVERY_HOSTS = ["127.0.0.1", "localhost"];
const DISCOVERY_PORTS = [3025, 3026, 3027, 3028, 3029, 3030, 3031, 3032, 3033, 3034, 3035];
const SERVER_SIGNATURE = "mcp-browser-connector-24x7";

function loadSettings() {
  return new Promise((resolve) => {
    try {
      api.storage.local.get("btmcpSettings", (stored) => {
        resolve({ ...DEFAULT_SETTINGS, ...(stored && stored.btmcpSettings) });
      });
    } catch {
      resolve({ ...DEFAULT_SETTINGS });
    }
  });
}

function saveSettings(settings) {
  return new Promise((resolve) => {
    try {
      api.storage.local.set({ btmcpSettings: settings }, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Confirms a real connector is listening, rather than some other local server. */
async function checkServer(host, port, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${host}:${port}/.identity`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const identity = await response.json();
    return identity && identity.signature === SERVER_SIGNATURE ? identity : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Finds the connector on loopback. Tries the configured address first, then
 * the small default port range.
 */
async function discoverServer(settings) {
  const candidates = [];
  const seen = new Set();
  const add = (host, port) => {
    const key = `${host}:${port}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({ host, port });
    }
  };

  if (DISCOVERY_HOSTS.includes(settings.serverHost)) {
    add(settings.serverHost, Number(settings.serverPort));
  }
  for (const host of DISCOVERY_HOSTS) {
    for (const port of DISCOVERY_PORTS) add(host, port);
  }

  // Probed together rather than one-at-a-time: the whole sweep is a couple of
  // dozen loopback requests and should take milliseconds, not half a minute.
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const identity = await checkServer(candidate.host, candidate.port);
      return identity ? { ...candidate, identity } : null;
    })
  );

  return results.find(Boolean) || null;
}
