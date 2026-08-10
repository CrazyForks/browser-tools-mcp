import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { createConnector, type Connector } from "../../src/connector/connector";
import { FakeExtension } from "../helpers/fake-extension";
import { parseCli } from "../../src/cli";

/**
 * Verbose mode prints each captured entry as it arrives.
 *
 * Without it there is no way to tell from a terminal whether capture is
 * working — the connector only reports lifecycle events, so a working setup and
 * a broken one look identical after startup.
 */

let connector: Connector;
let extension: FakeExtension | null = null;
let screenshotDir: string;
let stderrChunks: string[];
let stdoutChunks: string[];
let restore: Array<() => void>;

beforeEach(() => {
  screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-verbose-"));
  stderrChunks = [];
  stdoutChunks = [];
  restore = [];

  const realErr = process.stderr.write.bind(process.stderr);
  const realOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((chunk: any, ...rest: any[]) => {
    stderrChunks.push(String(chunk));
    return realErr(chunk, ...rest);
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    stdoutChunks.push(String(chunk));
    return realOut(chunk, ...rest);
  }) as typeof process.stdout.write;

  restore.push(() => {
    process.stderr.write = realErr;
    process.stdout.write = realOut;
  });
});

afterEach(async () => {
  for (const undo of restore) undo();
  await extension?.close();
  extension = null;
  await connector?.close();
  fs.rmSync(screenshotDir, { recursive: true, force: true });
});

async function start(verbose: boolean) {
  connector = await createConnector({ port: 0, screenshotDir, verbose });
  const ext = new FakeExtension({ port: connector.port, tabId: 42 });
  await ext.connect();
  await ext.waitForWelcome();
  ext.send({ type: "page", url: "https://example.com/app", tabId: 42 });
  extension = ext;
  return ext;
}

const stderr = () => stderrChunks.join("");

describe("verbose mode on", () => {
  it("prints console entries as they arrive", async () => {
    const ext = await start(true);
    ext.send({
      type: "console",
      entries: [
        { type: "console-error", level: "error", message: "Boom in checkout", timestamp: Date.now() },
      ],
    });

    await vi.waitFor(() => expect(stderr()).toContain("Boom in checkout"));
    expect(stderr()).toContain("console");
    expect(stderr()).toContain("error");
  });

  it("prints network entries with status and method", async () => {
    const ext = await start(true);
    ext.send({
      type: "network",
      entries: [
        {
          url: "https://api.test/checkout",
          method: "POST",
          status: 500,
          timestamp: Date.now(),
          durationMs: 123,
        },
      ],
    });

    await vi.waitFor(() => expect(stderr()).toContain("api.test/checkout"));
    const out = stderr();
    expect(out).toContain("500");
    expect(out).toContain("POST");
  });

  it("says which tab an entry came from", async () => {
    const ext = await start(true);
    ext.send({
      type: "console",
      entries: [{ type: "console-log", message: "from tab forty-two", timestamp: Date.now() }],
    });

    await vi.waitFor(() => expect(stderr()).toContain("from tab forty-two"));
    expect(stderr()).toMatch(/42/);
  });

  it("shortens a long entry rather than flooding the terminal", async () => {
    const ext = await start(true);
    ext.send({
      type: "console",
      entries: [{ type: "console-log", message: "L".repeat(4000), timestamp: Date.now() }],
    });

    await vi.waitFor(() => expect(stderr()).toContain("LLLL"));
    const line = stderr()
      .split("\n")
      .find((l) => l.includes("LLLL"))!;
    expect(line.length).toBeLessThan(400);
  });

  it("prints redacted values, never the original secret", async () => {
    const ext = await start(true);
    ext.send({
      type: "console",
      entries: [
        {
          type: "console-log",
          message: "token ghp" + "_1234567890abcdefghijklmnopqrstuvwx",
          timestamp: Date.now(),
        },
      ],
    });

    await vi.waitFor(() => expect(stderr()).toContain("[REDACTED]"));
    // Verbose output must not become a way to leak what redaction removed.
    expect(stderr()).not.toContain("ghp" + "_1234567890abcdefghijklmnopqrstuvwx");
  });

  /**
   * The MCP server shares this process with the JSON-RPC stream on stdout, so
   * verbose output going there would corrupt every session that enabled it.
   */
  it("writes only to stderr, never stdout", async () => {
    const ext = await start(true);
    ext.send({
      type: "console",
      entries: [{ type: "console-log", message: "MUST-NOT-REACH-STDOUT", timestamp: Date.now() }],
    });

    await vi.waitFor(() => expect(stderr()).toContain("MUST-NOT-REACH-STDOUT"));
    expect(stdoutChunks.join("")).not.toContain("MUST-NOT-REACH-STDOUT");
  });
});

describe("verbose mode off", () => {
  it("stays quiet about captured entries", async () => {
    const ext = await start(false);
    ext.send({
      type: "console",
      entries: [{ type: "console-log", message: "SHOULD-BE-SILENT", timestamp: Date.now() }],
    });
    ext.send({
      type: "network",
      entries: [{ url: "https://api.test/quiet", method: "GET", status: 200, timestamp: Date.now() }],
    });

    await vi.waitFor(() => expect(connector.store.queryConsole({}).total).toBe(1));
    await new Promise((r) => setTimeout(r, 200));

    expect(stderr()).not.toContain("SHOULD-BE-SILENT");
    expect(stderr()).not.toContain("api.test/quiet");
  });

  it("still reports lifecycle events", async () => {
    await start(false);
    expect(stderr()).toContain("Extension connected");
  });
});

describe("the flag", () => {
  it("is off by default", () => {
    expect(parseCli([], {}).verbose).toBe(false);
  });

  it("is set by --verbose", () => {
    expect(parseCli(["--verbose"], {}).verbose).toBe(true);
  });

  it("is set by the environment variable", () => {
    expect(parseCli([], { BROWSER_TOOLS_VERBOSE: "true" }).verbose).toBe(true);
  });

  it("is mentioned in the help text", async () => {
    const { helpText } = await import("../../src/cli");
    expect(helpText()).toContain("--verbose");
  });
});
