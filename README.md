# BrowserTools MCP

Give your AI coding agent eyes on the browser. BrowserTools MCP streams console
output, network activity, screenshots and Lighthouse audits from **your real
Chrome session** — the one already logged into your app — to any MCP-compatible
client: Cursor, Claude Code, Windsurf, Cline, Zed, Gemini CLI, and others.

> **Version 2.0 is a rewrite.** One process instead of three, no unauthenticated
> local server, credentials scrubbed before they leave the browser, and a real
> test suite. If you are coming from 1.x, read [MIGRATION.md](MIGRATION.md) —
> **and upgrade, because 1.2.x has a critical vulnerability.** See
> [SECURITY.md](SECURITY.md).

---

## Why this instead of a CDP-based server

Tools like Chrome DevTools MCP and Playwright MCP drive a *fresh, automated*
browser. That is the right choice for writing tests. It is the wrong choice for
debugging the app you are actually looking at, because since Chrome 136 the
browser refuses remote debugging on your default profile — the one holding your
logins. So you end up recreating your auth state in a throwaway profile before
you can debug anything.

BrowserTools attaches to the session you are already in, through a DevTools
extension. You stay logged in, on the page you were already on, and your agent
reads what you see. It also reports Lighthouse-grade performance, accessibility
and SEO data, which the automation-first servers do not.

## Install

Two pieces: an MCP server (one command) and a Chrome extension.

### 1. Point your MCP client at the server

```json
{
  "mcpServers": {
    "browser-tools": {
      "command": "npx",
      "args": ["-y", "@agentdeskai/browser-tools-mcp@latest"]
    }
  }
}
```

On Windows, if your client cannot find `npx`, use `"command": "cmd"` with
`"args": ["/c", "npx", "-y", "@agentdeskai/browser-tools-mcp@latest"]`.

Requires **Node 22.19 or newer**. Check with `node --version`; if you use nvm or
asdf, make sure your editor inherits the same version.

### 2. Load the Chrome extension

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select the `chrome-extension` directory.

That is the whole setup. **There is no second server to start** — the MCP server
runs the connector itself.

### 3. Use it

Open Chrome DevTools (F12) on the page you want to inspect. Capture begins as
soon as DevTools is open; the **BrowserTools** panel is only for settings and
status. Then ask your agent something like *"check the console for errors"* or
*"run an accessibility audit on this page"*.

Not working? Run `npx @agentdeskai/browser-tools-mcp --doctor`, which reports
exactly which piece is missing.

## Tools

| Tool | What it does |
| --- | --- |
| `getConsoleLogs` | Console output, filterable by keyword with paging |
| `getConsoleErrors` | Error-level output and uncaught exceptions |
| `getNetworkLogs` | XHR/fetch requests with status, timing and bodies |
| `getNetworkErrors` | Only failed and 4xx/5xx requests |
| `getSelectedElement` | The element selected in the Elements panel |
| `getPageInfo` | Which page the browser is currently on |
| `getConnectionStatus` | Whether the extension is connected, and capture counts |
| `takeScreenshot` | Screenshot returned **as an image**, plus its file path |
| `refreshBrowser` | Reloads the inspected tab |
| `getBrowserStorage` | localStorage, sessionStorage and cookies (values gated) |
| `wipeLogs` | Clears captured telemetry before a clean reproduction |
| `runAccessibilityAudit` | Lighthouse accessibility audit |
| `runPerformanceAudit` | Lighthouse performance audit with Core Web Vitals |
| `runSEOAudit` | Lighthouse SEO audit |
| `runBestPracticesAudit` | Lighthouse best-practices audit |

Three prompts ship alongside them — `debuggerMode`, `auditMode` and
`nextjsSeoAudit` — giving your agent a systematic workflow instead of a wall of
static text in every tool listing.

All tools declare MCP output schemas, so clients receive structured data rather
than prose they have to parse, and read-only tools are annotated as such so
clients can auto-approve them safely.

### Keeping responses small

Log payloads are the usual cause of a blown context window. Every read tool
takes `limit` and `offset`, and the log tools take keyword filters:

```
getConsoleErrors({ keywords: ["hydration"], limit: 20 })
getNetworkLogs({ urlKeywords: ["/api/"], bodyKeywords: ["quota"], limit: 10 })
```

Results are returned newest-first and always report `total` alongside
`returned`, so an agent knows when it is only seeing part of the picture.

## Privacy and security

This tool captures whatever your browser sees, so it treats that data carefully:

- **Loopback only.** The connector binds `127.0.0.1` and refuses non-loopback
  addresses. In 1.x it bound `0.0.0.0`, reachable by anyone on your network.
- **The extension never leaves loopback.** 1.x scanned private network ranges
  and adopted whichever host answered with a known string — meaning anyone on
  shared Wi-Fi could receive your logs and screenshots. That scan is gone.
- **Authenticated.** The HTTP API requires a per-run token. The WebSocket
  accepts browser-extension origins only, so a web page you visit cannot
  impersonate the extension.
- **Credentials are scrubbed** on the way in: `Authorization`, `Cookie` and
  similar headers, plus JWTs, cloud keys and vendor tokens found anywhere in
  captured strings, become `[REDACTED]`.
- **Headers are off by default**, per direction, and storage values are withheld
  unless explicitly requested.
- **Cookie access is an optional permission** you grant from the panel, not
  something the extension holds by default.

Report vulnerabilities per [SECURITY.md](SECURITY.md).

## Configuration

Flags, or the matching `BROWSER_TOOLS_*` environment variables:

| Flag | Purpose |
| --- | --- |
| `--port <n>` | Connector port (default 3025) |
| `--screenshot-dir <path>` | Where screenshots are written |
| `--only <a,b>` | Expose only these tools |
| `--exclude <a,b>` | Hide these tools |
| `--doctor` | Check the setup and exit |
| `--no-redact` | Disable credential scrubbing (not recommended) |

To share one browser session between several MCP clients, start the connector
once with `npx @agentdeskai/browser-tools-server` and every client will attach to
it automatically.

## Known limits

- Network capture starts when DevTools opens. Requests that finished before then
  are not recorded — reload the page to capture a full page load.
- Console capture defaults to the DevTools protocol, which makes Chrome show a
  "started debugging this browser" banner. Switch the panel's capture mode to
  **Wrap page console** to avoid it; that mode is also what Firefox uses.
- Audits launch a separate headless Chrome and take up to a minute.

## Development

```bash
npm install
npm run build
npm test           # unit + integration, no browser required
npm run test:e2e   # real Chromium with the extension loaded
```

`npm test` runs in seconds. The end-to-end suite launches a headed Chromium with
the extension installed, drives fixture pages, and asserts the whole capture
path — run `npx playwright install chromium` first.

## License

MIT
