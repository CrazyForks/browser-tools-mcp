import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext } from "playwright";

import { createConnector, type Connector } from "../../src/connector/connector";
import { startFixtureServer, type FixtureServer } from "../fixtures/server";

/**
 * The one test that exercises the real contract between the extension and the
 * connector: a real Chromium, with the real extension loaded, driving a real
 * page, into a real connector.
 *
 * Nothing else can verify this seam — it is where the capture path, the
 * websocket protocol and the screenshot path all meet.
 */

const extensionPath = path.resolve(
  fileURLToPath(new URL("../../../chrome-extension", import.meta.url))
);

let connector: Connector;
let fixture: FixtureServer;
let context: BrowserContext | null = null;
let userDataDir: string;
let screenshotDir: string;
let launchFailure: string | null = null;

beforeAll(async () => {
  expect(fs.existsSync(path.join(extensionPath, "manifest.json"))).toBe(true);

  screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-e2e-shots-"));
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-e2e-profile-"));

  fixture = await startFixtureServer();

  // The extension only looks at loopback ports 3025-3035, so the connector has
  // to land in that range for discovery to find it.
  connector = await createConnector({ port: 3025, screenshotDir, heartbeatIntervalMs: 5_000 });

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        // Opening DevTools is what loads the extension's devtools page, which
        // is where all the capture logic lives.
        "--auto-open-devtools-for-tabs",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
      ],
    });
  } catch (error) {
    launchFailure = error instanceof Error ? error.message : String(error);
  }
}, 180_000);

afterAll(async () => {
  await context?.close().catch(() => {});
  await connector?.close();
  await fixture?.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(screenshotDir, { recursive: true, force: true });
});

async function waitFor<T>(
  probe: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await probe();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out. Last value: ${JSON.stringify(last)?.slice(0, 600)}`);
}

/**
 * Opens the fixture page and returns once capture is actually live.
 *
 * DevTools reports network activity only from the point its listeners are
 * registered, and `--auto-open-devtools-for-tabs` finishes wiring up the
 * extension's devtools page slightly after the first navigation has already
 * issued its requests. Reloading once the connection exists reproduces what a
 * user sees: DevTools open, then the page loads.
 */
async function openPageWithLiveCapture() {
  const page = await context!.newPage();
  await page.goto(fixture.url, { waitUntil: "load" });

  await waitFor(
    () => connector.hasExtension(),
    (connected) => connected === true,
    45_000
  );
  await new Promise((resolve) => setTimeout(resolve, 500));

  connector.store.wipe();
  await page.reload({ waitUntil: "load" });
  return page;
}

describe("extension to connector, end to end", () => {
  it("loads the extension and connects to the connector", async () => {
    if (launchFailure) {
      // A headed Chromium is not always available (no display, sandbox
      // restrictions). Say so loudly rather than reporting a false pass.
      throw new Error(
        `Could not launch Chromium with the extension loaded: ${launchFailure}. ` +
          `Run 'npx playwright install chromium' and re-run with a display available.`
      );
    }

    const page = await context!.newPage();
    await page.goto(fixture.url, { waitUntil: "load" });

    await waitFor(
      () => connector.hasExtension(),
      (connected) => connected === true,
      45_000
    );

    expect(connector.hasExtension()).toBe(true);
    await page.close();
  }, 120_000);

  it("captures console output from the page", async () => {
    const page = await context!.newPage();
    await page.goto(fixture.url, { waitUntil: "load" });

    const result = await waitFor(
      () => connector.store.queryConsole({}),
      (r) => r.entries.some((e) => e.message.includes("MARKER-CONSOLE-LOG")),
      45_000
    );

    const messages = result.entries.map((e) => e.message).join("\n");
    expect(messages).toContain("MARKER-CONSOLE-LOG");
    expect(messages).toContain("MARKER-CONSOLE-ERROR");

    await page.close();
  }, 120_000);

  it("classifies console errors", async () => {
    const page = await context!.newPage();
    await page.goto(fixture.url, { waitUntil: "load" });

    const errors = await waitFor(
      () => connector.store.queryConsole({ errorsOnly: true }),
      (r) => r.entries.some((e) => e.message.includes("MARKER-CONSOLE-ERROR")),
      45_000
    );

    expect(errors.entries.every((e) => e.level === "error" || e.level === "assert")).toBe(true);
    await page.close();
  }, 120_000);

  it("captures network requests, including failures", async () => {
    const page = await openPageWithLiveCapture();

    const all = await waitFor(
      () => connector.store.queryNetwork({}),
      (r) => r.entries.some((e) => e.url.includes("/api/ok")),
      45_000
    );
    expect(all.entries.some((e) => e.url.includes("/api/ok"))).toBe(true);

    const failures = await waitFor(
      () => connector.store.queryNetwork({ errorsOnly: true }),
      (r) => r.entries.some((e) => e.url.includes("/api/fail")),
      45_000
    );
    expect(failures.entries.find((e) => e.url.includes("/api/fail"))?.status).toBe(500);

    await page.close();
  }, 120_000);

  it("scrubs credentials before they reach the store", async () => {
    const page = await openPageWithLiveCapture();

    await waitFor(
      () => connector.store.queryNetwork({}),
      (r) => r.entries.some((e) => e.url.includes("/api/secret")),
      45_000
    );

    // Headers are off by default, and the token in the body must be redacted.
    const everything = JSON.stringify({
      console: connector.store.queryConsole({}),
      network: connector.store.queryNetwork({}),
    });

    expect(everything).not.toContain("SUPERSECRETCOOKIEVALUE");
    expect(everything).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");

    await page.close();
  }, 120_000);

  it("tracks the page the browser is on", async () => {
    const page = await context!.newPage();
    await page.goto(fixture.url, { waitUntil: "load" });

    const state = await waitFor(
      () => connector.store.getCurrentPage(),
      (p) => typeof p.url === "string" && p.url.includes(String(fixture.port)),
      45_000
    );

    expect(state.url).toContain("127.0.0.1");
    await page.close();
  }, 120_000);

  it("takes a real screenshot of the inspected page", async () => {
    const page = await context!.newPage();
    await page.goto(fixture.url, { waitUntil: "load" });

    await waitFor(
      () => connector.hasExtension(),
      (connected) => connected === true,
      45_000
    );

    const result = await connector.captureScreenshot({});

    expect(fs.existsSync(result.path)).toBe(true);
    const bytes = fs.readFileSync(result.path);
    // A real PNG, and big enough to be an actual page rather than a stub.
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(bytes.length).toBeGreaterThan(1000);
    expect(result.path.startsWith(path.resolve(screenshotDir))).toBe(true);

    await page.close();
  }, 120_000);

  it("reloads the page on request", async () => {
    const page = await context!.newPage();
    await page.goto(fixture.url, { waitUntil: "load" });

    await waitFor(
      () => connector.hasExtension(),
      (connected) => connected === true,
      45_000
    );

    connector.store.wipe();
    await connector.refreshTab();

    // A reload replays the page script, so the markers come back.
    await waitFor(
      () => connector.store.queryConsole({}),
      (r) => r.entries.some((e) => e.message.includes("MARKER-CONSOLE-LOG")),
      45_000
    );

    await page.close();
  }, 120_000);

  it("reads web storage through the extension", async () => {
    const page = await openPageWithLiveCapture();
    await page.evaluate(() => {
      localStorage.setItem("btmcp-e2e", "MARKER-STORAGE-VALUE");
    });

    const storage = await connector.readStorage(["localStorage"]);

    expect(JSON.stringify(storage)).toContain("btmcp-e2e");
    expect(JSON.stringify(storage)).toContain("MARKER-STORAGE-VALUE");

    await page.close();
  }, 120_000);
});
