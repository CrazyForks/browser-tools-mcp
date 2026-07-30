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
