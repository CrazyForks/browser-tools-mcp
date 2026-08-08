import { describe, it, expect } from "vitest";
import {
  redactHeaders,
  redactSecretsInString,
  redactValue,
  SENSITIVE_HEADERS,
} from "../../src/util/redact";

describe("redactHeaders", () => {
  it("redacts credential-bearing headers regardless of case", () => {
    const out = redactHeaders({
      Authorization: "Bearer abc.def.ghi",
      COOKIE: "session=deadbeef",
      "Set-Cookie": "session=deadbeef; HttpOnly",
      "X-Api-Key": "sk-live-1234",
      "Content-Type": "application/json",
    });

    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.COOKIE).toBe("[REDACTED]");
    expect(out["Set-Cookie"]).toBe("[REDACTED]");
    expect(out["X-Api-Key"]).toBe("[REDACTED]");
    // Non-sensitive headers must survive untouched — they are the useful part.
    expect(out["Content-Type"]).toBe("application/json");
  });

  it("covers the documented sensitive header list", () => {
    for (const name of SENSITIVE_HEADERS) {
      const out = redactHeaders({ [name]: "secret-value" });
      expect(out[name], `${name} should be redacted`).toBe("[REDACTED]");
    }
  });

  it("returns a new object and does not mutate the input", () => {
    const input = { authorization: "Bearer x" };
    const out = redactHeaders(input);
    expect(input.authorization).toBe("Bearer x");
    expect(out).not.toBe(input);
  });

  it("handles array-valued headers", () => {
    const out = redactHeaders({ "set-cookie": ["a=1", "b=2"] as unknown as string });
    expect(out["set-cookie"]).toBe("[REDACTED]");
  });
});

describe("redactSecretsInString", () => {
  const cases: Array<[string, string]> = [
    ["JWT", "token is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-_123"],
    ["AWS access key", "AKIAIOSFODNN7EXAMPLE"],
    ["GitHub PAT", "ghp_1234567890abcdefghijklmnopqrstuvwx"],
    ["GitHub fine-grained PAT", "github_pat_11ABCDE0Y0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ"],
    ["OpenAI key", "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"],
    ["Anthropic key", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"],
    ["Slack token", "xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx"],
    ["Stripe live key", "sk_live_abcdefghijklmnopqrstuvwx"],
    ["Bearer header value", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"],
  ];

  for (const [label, sample] of cases) {
    it(`redacts ${label}`, () => {
      const out = redactSecretsInString(sample);
      expect(out).toContain("[REDACTED]");
      // The raw secret must not survive anywhere in the output.
      const secret = sample.split(/\s|:/).filter(Boolean).pop()!;
      expect(out).not.toContain(secret);
    });
  }

  it("redacts secret-ish JSON values by key name", () => {
    const out = redactSecretsInString(
      '{"user":"ted","password":"hunter2","api_secret":"s3cr3t","count":3}'
    );
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("s3cr3t");
    // Benign fields survive so the log stays useful.
    expect(out).toContain('"user":"ted"');
    expect(out).toContain('"count":3');
  });

  it("redacts PEM private key blocks", () => {
    const out = redactSecretsInString(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----"
    );
    expect(out).not.toContain("MIIEow==");
    expect(out).toContain("[REDACTED]");
  });

  it("leaves ordinary text alone", () => {
    const text = "GET /api/users returned 200 in 34ms";
    expect(redactSecretsInString(text)).toBe(text);
  });

  it("is safe on empty and non-string-ish input", () => {
    expect(redactSecretsInString("")).toBe("");
  });
});

describe("redactValue", () => {
  it("walks nested objects and arrays", () => {
    const out = redactValue({
      headers: { authorization: "Bearer xyz" },
      items: [{ note: "ghp_1234567890abcdefghijklmnopqrstuvwx" }],
      nested: { deep: { cookie: "a=b" } },
    }) as any;

    expect(out.headers.authorization).toBe("[REDACTED]");
    expect(out.items[0].note).toBe("[REDACTED]");
    expect(out.nested.deep.cookie).toBe("[REDACTED]");
  });

  it("preserves primitives and structure", () => {
    const out = redactValue({ n: 1, b: true, nil: null, arr: [1, 2] }) as any;
    expect(out).toEqual({ n: 1, b: true, nil: null, arr: [1, 2] });
  });

  it("does not blow up on circular structures", () => {
    const a: any = { name: "a" };
    a.self = a;
    expect(() => redactValue(a)).not.toThrow();
  });

  it("can be disabled", () => {
    const out = redactValue({ authorization: "Bearer xyz" }, { enabled: false }) as any;
    expect(out.authorization).toBe("Bearer xyz");
  });
});

/**
 * Regression tests from a real leak.
 *
 * Manual testing against a live Clerk-authenticated app found a JWT and four
 * session ids surviving redaction. Two causes: the extension truncates strings
 * before sending, so a long JWT arrived with only one of its three segments and
 * no longer matched the JWT pattern; and there was no pattern for vendor
 * session identifiers at all, which appeared in both response bodies and URL
 * paths.
 */
describe("truncated secrets", () => {
  it("redacts a JWT that lost its later segments to truncation", () => {
    const chopped = "eyJhbGciOiJSUzI1NiIsImNhdCI6ImNsX0I3ZDRQZDRQZDRQIiwia2lkIjoiaW5zXzJa";
    const out = redactSecretsInString(`token is ${chopped}... (truncated)`);

    expect(out).not.toContain(chopped);
    expect(out).toContain("[REDACTED]");
  });

  it("still redacts a complete three-segment JWT", () => {
    const full = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r0";
    expect(redactSecretsInString(full)).not.toContain(full);
  });

  it("does not mangle ordinary base64 that is not a token", () => {
    // A short base64 blob in a log line should survive; only JWT-shaped
    // payloads (which start with the encoded '{"') are worth destroying.
    const text = "image data: iVBORw0KGgoAAAANSUhEUg";
    expect(redactSecretsInString(text)).toBe(text);
  });
});

describe("vendor session identifiers", () => {
  const identifiers = [
    ["Clerk session", "sess_3HWEvAAPLW3pElwMd0oolLs5aF7"],
    ["Clerk client", "client_3GmhO0nHNv39mTjwcKR6AbTJW0F"],
    ["generic token id", "tok_1PxyzABCDEFGHIJKLMNOPQRS"],
  ];

  for (const [label, value] of identifiers) {
    it(`redacts a ${label}`, () => {
      const out = redactSecretsInString(`{"id":"${value}","status":"active"}`);
      expect(out, label).not.toContain(value);
      expect(out).toContain("[REDACTED]");
    });
  }

  it("redacts a session id embedded in a URL path", () => {
    // This is where it actually leaked: the request URL itself.
    const url =
      "https://sweet-sloth-1.clerk.accounts.dev/v1/client/sessions/sess_3HWEvAAPLW3pElwMd0oolLs5aF7/touch?_clerk_js_version=6.26.0";
    const out = redactSecretsInString(url);

    expect(out).not.toContain("sess_3HWEvAAPLW3pElwMd0oolLs5aF7");
    // The rest of the URL has to survive, or the log stops being useful.
    expect(out).toContain("clerk.accounts.dev");
    expect(out).toContain("/touch");
  });

  it("leaves short underscore-suffixed words alone", () => {
    // Guard against over-matching ordinary identifiers.
    const text = "user_id=42 and item_name=widget";
    expect(redactSecretsInString(text)).toBe(text);
  });
});

/**
 * "eyJ" is only base64 for '{"', so any base64-encoded JSON starts that way.
 * Matching on the prefix alone destroyed innocent data — Clerk encodes image
 * parameters exactly like this, and a profile image URL came back as
 * https://img.clerk.com/[REDACTED], which is useless for debugging.
 *
 * A JWT is distinguishable: its first segment decodes to a header carrying
 * "alg". That survives truncation, because the header comes first.
 */
describe("base64 JSON that is not a token", () => {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  it("leaves a Clerk image URL intact", () => {
    const param = b64({ type: "proxy", src: "https://images.clerk.dev/oauth_google/img_2abc" });
    const url = `https://img.clerk.com/${param}`;

    expect(redactSecretsInString(url)).toBe(url);
  });

  it("leaves other base64-encoded JSON parameters intact", () => {
    const param = b64({ width: 200, height: 200, fit: "crop" });
    const text = `loading https://cdn.example.com/i/${param}`;

    expect(redactSecretsInString(text)).toBe(text);
  });

  it("still redacts a truncated JWT, which carries alg in its header", () => {
    const header = b64({ alg: "RS256", typ: "JWT", kid: "ins_2Z" });
    const truncated = `${header}XXXXXXXXXXXXXXXXXXXX`;

    const out = redactSecretsInString(`auth ${truncated}`);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(header);
  });

  it("still redacts a complete three-segment JWT", () => {
    const full =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r0";
    expect(redactSecretsInString(full)).not.toContain(full);
  });

  it("redacts a three-segment token even when its header is unreadable", () => {
    // Three dot-separated base64 segments is JWT-shaped regardless of contents.
    const shaped = "eyJzb21ldGhpbmdlbHNlIjoxfQ.eyJzdWIiOiJhIn0.c2lnbmF0dXJlaGVyZQ";
    expect(redactSecretsInString(shaped)).toContain("[REDACTED]");
  });
});
