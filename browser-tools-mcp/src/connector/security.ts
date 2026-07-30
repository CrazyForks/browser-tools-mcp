import type { Request, Response, NextFunction } from "express";
import { tokensMatch } from "../util/session.js";

/** Hostnames a request is allowed to arrive as. Anything else is a rebind. */
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Browser extension origins. A web page cannot forge these — the browser sets
 * Origin itself — so this is what keeps a visited page out of the connector.
 */
const EXTENSION_ORIGIN =
  /^(chrome-extension|moz-extension|safari-web-extension|extension):\/\/[A-Za-z0-9._-]+$/;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export function isExtensionOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  return EXTENSION_ORIGIN.test(origin);
}

function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  // Strip the port; keep bracketed IPv6 intact.
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  const colon = hostHeader.lastIndexOf(":");
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
}

/**
 * Rejects requests that did not come from this machine addressed as localhost,
 * and any request carrying a web-page Origin.
 *
 * Together these close the cross-site path that made every endpoint reachable
 * from any page the user happened to visit.
 */
export function localOnlyGuard() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const hostname = hostnameOf(req.headers.host);
    if (!ALLOWED_HOSTNAMES.has(hostname)) {
      res.status(403).json({
        error: "Requests must address this server as localhost",
        code: "FORBIDDEN_HOST",
      });
      return;
    }

    const origin = req.headers.origin;
    if (origin && !isExtensionOrigin(origin)) {
      res.status(403).json({
        error: "Cross-origin requests are not accepted",
        code: "FORBIDDEN_ORIGIN",
      });
      return;
    }

    next();
  };
}

/** Requires a bearer token on the API surface. */
export function requireToken(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const presented = match?.[1] ?? (typeof req.query["token"] === "string" ? req.query["token"] : "");

    if (!presented || !tokensMatch(presented, token)) {
      res.status(401).json({
        error: "Missing or invalid authorization token",
        code: "UNAUTHORIZED",
      });
      return;
    }
    next();
  };
}
