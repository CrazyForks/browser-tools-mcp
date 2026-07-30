import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A small site with deterministic, greppable output, so end-to-end assertions
 * can look for exact markers rather than guessing at real-world page noise.
 */
const PAGE = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>BrowserTools fixture</title></head>
  <body>
    <h1 id="heading">BrowserTools fixture page</h1>
    <button id="target" data-testid="target">Click me</button>
    <img src="/image.png" />
    <script>
      console.log("MARKER-CONSOLE-LOG");
      console.info("MARKER-CONSOLE-INFO");
      console.warn("MARKER-CONSOLE-WARN");
      console.error("MARKER-CONSOLE-ERROR");

      fetch("/api/ok")
        .then(function (r) { return r.json(); })
        .then(function () { console.log("MARKER-FETCH-OK"); });

      fetch("/api/fail").then(function () { console.log("MARKER-FETCH-FAIL"); });

      fetch("/api/secret").then(function () { console.log("MARKER-FETCH-SECRET"); });

      setTimeout(function () {
        console.log("MARKER-LATE-LOG");
      }, 400);
    </script>
  </body>
</html>`;

export interface FixtureServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/api/ok") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, marker: "MARKER-RESPONSE-BODY" }));
      return;
    }

    if (url === "/api/fail") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "MARKER-SERVER-ERROR" }));
      return;
    }

    // Used to prove credentials are scrubbed before they reach the store.
    if (url === "/api/secret") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "session=SUPERSECRETCOOKIEVALUE; Path=/",
      });
      res.end(JSON.stringify({ token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }));
      return;
    }

    if (url === "/image.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64"
        )
      );
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
