import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The extension's own credential scrubbing, tested against the shipped file.
 *
 * This is the fix for a leak found in manual testing: the extension truncated
 * strings before sending, so a JWT longer than the limit arrived as a lone
 * header segment that no longer matched the token pattern. Scrubbing now
 * happens before truncation, in the browser, so secrets never cross the socket.
 *
 * Loaded from chrome-extension/shared.js rather than reimplemented, so this
 * cannot drift from what actually runs.
 */

const sharedJsPath = path.resolve(
  fileURLToPath(new URL("../../../chrome-extension/shared.js", import.meta.url))
);

let scrubAndTruncate: (value: string, limit: number) => string;
let scrubSecrets: (value: string) => string;

beforeAll(() => {
  const source = fs.readFileSync(sharedJsPath, "utf8");
  const extract = new Function(
    `${source}\nreturn { scrubAndTruncate, scrubSecrets };`
  ) as () => { scrubAndTruncate: typeof scrubAndTruncate; scrubSecrets: typeof scrubSecrets };
  ({ scrubAndTruncate, scrubSecrets } = extract());
});

describe("scrubbing happens before truncation", () => {
  it("catches a JWT that is longer than the truncation limit", () => {
    // The exact failure: a 700-char JWT truncated at 500 lost its later
    // segments, and the server could no longer recognise what was left.
    const jwt =
      "eyJhbGciOiJSUzI1NiIsImNhdCI6ImNsX0I3ZDRQZDRQZDRQIiwia2lkIjoiaW5zXzJa" +
      "X".repeat(600) +
      ".eyJzdWIiOiJ1c2VyIn0.SIGNATUREabcdef123456";
    expect(jwt.length).toBeGreaterThan(500);

    const out = scrubAndTruncate(`{"jwt":"${jwt}"}`, 500);

    expect(out).not.toContain("eyJhbGciOiJSUzI1NiIsImNhdCI6");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts session ids in a URL path", () => {
    const url =
      "https://sweet-sloth-1.clerk.accounts.dev/v1/client/sessions/sess_3HWEvAAPLW3pElwMd0oolLs5aF7/touch";
    const out = scrubAndTruncate(url, 500);

    expect(out).not.toContain("sess_3HWEvAAPLW3pElwMd0oolLs5aF7");
    expect(out).toContain("clerk.accounts.dev");
    expect(out).toContain("/touch");
  });

  it("redacts client ids in a response body", () => {
    const body = '{"object":"client","id":"client_3GmhO0nHNv39mTjwcKR6AbTJW0F"}';
    expect(scrubAndTruncate(body, 500)).not.toContain("client_3GmhO0nHNv39mTjwcKR6AbTJW0F");
  });

  it("still truncates once scrubbed", () => {
    const out = scrubAndTruncate("y".repeat(900), 100);
    expect(out.length).toBeLessThan(200);
    expect(out).toContain("truncated");
  });

  it("leaves ordinary page output untouched", () => {
    const text = "GET /api/users returned 200 in 34ms";
    expect(scrubAndTruncate(text, 500)).toBe(text);
  });

  it("passes non-strings through unharmed", () => {
    expect(scrubAndTruncate(undefined as unknown as string, 500)).toBeUndefined();
    expect(scrubAndTruncate(42 as unknown as string, 500)).toBe(42);
  });
});

describe("extension and server scrubbing agree", () => {
  it("covers the same vendor prefixes the server does", async () => {
    const { redactSecretsInString } = await import("../../src/util/redact");

    const samples = [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-_123456789012",
      "sess_3HWEvAAPLW3pElwMd0oolLs5aF7",
      "ghp_1234567890abcdefghijklmnopqrstuvwx",
      "AKIAIOSFODNN7EXAMPLE",
      "sk_live_abcdefghijklmnopqrstuvwx",
    ];

    // Both layers run; they must not disagree about what is a secret.
    for (const sample of samples) {
      expect(scrubSecrets(sample), `extension: ${sample}`).toContain("[REDACTED]");
      expect(redactSecretsInString(sample), `server: ${sample}`).toContain("[REDACTED]");
    }
  });
});
