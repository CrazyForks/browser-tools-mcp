/**
 * Credential scrubbing for anything captured from the browser.
 *
 * Everything this project captures — request/response headers, response
 * bodies, console output — routinely contains session cookies, bearer tokens
 * and API keys. All of it is forwarded to an LLM client, so it is scrubbed on
 * the way into the store rather than on the way out.
 */

export const REDACTED = "[REDACTED]";

/** Header names whose value is always a credential. Compared case-insensitively. */
export const SENSITIVE_HEADERS: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "authentication",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
  "x-session-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-amz-security-token",
  "x-goog-api-key",
  "x-functions-key",
  "x-secret",
];

const SENSITIVE_HEADER_SET = new Set(SENSITIVE_HEADERS);

/**
 * High-confidence secret shapes. These are deliberately anchored to vendor
 * prefixes so that ordinary log text is never mangled — a false positive
 * silently destroys debugging information, which is the thing this tool exists
 * to provide.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // PEM private key blocks (must run first — it spans lines).
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
  // Vendor session and client identifiers, e.g. Clerk's sess_… and client_….
  // These are bearer-equivalent: they appear in URL paths as well as bodies.
  /\b(?:sess|session|client|tok|token|auth|cred|secret|apikey)_[A-Za-z0-9]{16,}\b/gi,
  // AWS access key IDs.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  // GitHub tokens, classic and fine-grained.
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // OpenAI / Anthropic style keys.
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  // Stripe and similar prefixed live/test keys.
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google API keys.
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
];

/**
 * Candidates for a JSON Web Token: base64url that starts with an encoded '{"'.
 *
 * Matching this alone is not enough. "eyJ" is simply base64 for '{"', so every
 * base64-encoded JSON object looks the same at the start — Clerk encodes image
 * parameters exactly this way, and treating those as secrets turned profile
 * image URLs into https://img.clerk.com/[REDACTED]. Each candidate is checked
 * by isJwt() below.
 */
const JWT_CANDIDATE = /\beyJ[A-Za-z0-9_-]{15,}(?:\.[A-Za-z0-9_-]+){0,2}/g;

/** Fields that appear in a JWT header and not in ordinary encoded JSON. */
const JWT_HEADER_FIELDS = /"(?:alg|typ|kid)"/;

function decodeBase64Prefix(value: string): string {
  // Decode a whole number of base64 groups, since the tail may be cut off.
  const usable = value.slice(0, 40);
  const aligned = usable.slice(0, usable.length - (usable.length % 4));
  if (aligned.length === 0) return "";
  try {
    return Buffer.from(aligned.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Decides whether a base64url run is really a token.
 *
 * Three dot-separated segments is JWT-shaped whatever it contains. With fewer —
 * which is what truncation leaves behind — the header is decoded and checked
 * for the fields only a JWT carries.
 */
export function isJwt(candidate: string): boolean {
  if (candidate.split(".").length >= 3) return true;
  const header = candidate.split(".")[0] ?? "";
  return JWT_HEADER_FIELDS.test(decodeBase64Prefix(header));
}

/** `Authorization: Bearer <token>` style values appearing inline in text. */
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

/**
 * JSON/querystring style `"password": "..."` pairs. Matched by key name, since
 * the value itself has no recognisable shape.
 */
const SECRETISH_KEY_PATTERN =
  /("(?:[^"]*(?:password|passwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key|auth)[^"]*)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

/** Replaces secret-shaped substrings in a single string. */
export function redactSecretsInString(input: string): string {
  if (!input) return input;

  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  out = out.replace(JWT_CANDIDATE, (match) => (isJwt(match) ? REDACTED : match));
  out = out.replace(AUTH_SCHEME_PATTERN, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(SECRETISH_KEY_PATTERN, (_m, keyPart: string) => `${keyPart}"${REDACTED}"`);
  return out;
}

function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_SET.has(name.toLowerCase());
}

/**
 * Redacts credential-bearing headers while leaving the rest intact — the
 * non-sensitive headers are usually what makes a network log worth reading.
 */
export function redactHeaders(
  headers: Record<string, string> | undefined | null
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== "object") return out;

  for (const [name, value] of Object.entries(headers)) {
    if (isSensitiveHeaderName(name)) {
      out[name] = REDACTED;
    } else if (Array.isArray(value)) {
      out[name] = value.map((v) => redactSecretsInString(String(v))).join(", ");
    } else if (typeof value === "string") {
      out[name] = redactSecretsInString(value);
    } else {
      out[name] = value as unknown as string;
    }
  }
  return out;
}

export interface RedactOptions {
  /** Set false to pass data through untouched. */
  enabled?: boolean;
}

/**
 * Recursively redacts a captured value: sensitive keys by name, and
 * secret-shaped substrings anywhere in the remaining strings.
 */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  if (options.enabled === false) return value;
  return walk(value, new WeakSet());
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSecretsInString(value);
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveHeaderName(key) || isSecretishKey(key)
      ? REDACTED
      : walk(item, seen);
  }
  return out;
}

const SECRETISH_KEY_NAME =
  /(password|passwd|secret|api[_-]?key|apikey|credential|private[_-]?key|access[_-]?token|refresh[_-]?token)/i;

function isSecretishKey(key: string): boolean {
  return SECRETISH_KEY_NAME.test(key);
}
