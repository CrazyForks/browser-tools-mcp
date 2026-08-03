# Changelog

## 2.0.0

A rewrite. See [MIGRATION.md](MIGRATION.md) to upgrade and [SECURITY.md](SECURITY.md)
for the vulnerabilities this release fixes.

### Security

- **Fixed remote code execution.** A caller-supplied path arriving over an
  unauthenticated WebSocket was interpolated into an `osascript` shell command.
  The AppleScript path is gone; screenshot names are restricted and resolved
  inside a fixed directory. (#224, #232, #233)
- **Stopped binding every network interface.** The connector binds `127.0.0.1`
  and refuses non-loopback addresses without an explicit override. It previously
  defaulted to `0.0.0.0`.
- **Removed the extension's local network scan.** It probed private IP ranges
  and adopted any host answering with a public constant, which let anyone on the
  same network receive captured logs and screenshots.
- **Added authentication.** The HTTP API requires a per-run bearer token stored
  `0600`; the WebSocket accepts only browser-extension origins; `Host` is
  validated against DNS rebinding; wildcard CORS is gone.
- **Added credential redaction.** Credential-bearing headers and secret-shaped
  strings are scrubbed before storage. Headers are off by default. (#228)
- **Allowlisted settings.** An unauthenticated request body could previously be
  spread over server settings, allowing memory exhaustion and log injection.

### Fixed

- Discovery logging no longer corrupts the MCP stdio stream; all diagnostics go
  to stderr. (#239, #103, #183, #159)
- Startup no longer blocks on a sequential 33-second port scan before answering
  `initialize`. (#226, #95, #91)
- Screenshots capture the inspected page through the DevTools protocol, so they
  work with DevTools undocked and never photograph the DevTools window itself.
  (#79, #189, #81)
- Concurrent screenshot requests are correlated by request id instead of
  resolving whichever callback happened to be first. (#81, #130)
- `takeScreenshot` returns the image to the model instead of a bare success
  string. (#200, #52, #181, #111)
- Changing host or port in the panel now reconnects. The old comparison checked
  a value against itself after assignment and was always false.
- The extension answers the server's heartbeat, so dead connections are detected
  instead of being logged as an unhandled message type. (#120)
- A second DevTools window no longer silently steals the connection. (#43)
- Socket errors no longer take down the process — the WebSocket had no `error`
  handler.
- Log queries return the newest entries and no longer let one oversized entry
  hide everything after it.
- Telemetry captured before the connector handshake completes is buffered rather
  than dropped, so page-load activity is not lost.
- `getNetworkErrors` no longer reports success as a tool error.
- Audits fail immediately with an explanation when no page URL is known, instead
  of polling a variable nothing set for 25 seconds.
- Windows drive paths convert correctly on POSIX hosts; the previous
  implementation left the drive prefix in place.
- `stringSizeLimit` now applies to selected-element markup. (#137)

### Added

- Single-process operation: the MCP server embeds the connector. No second
  terminal.
- `--doctor` reports Node version, connector state, extension connection and
  screenshot writability, with a fix for each problem found.
- `getPageInfo`, `getConnectionStatus`, `refreshBrowser` (#185, #99, #196, #57)
  and `getBrowserStorage` (#49) tools.
- Keyword filtering and `limit`/`offset` paging on all log tools. (#218, #205)
- Tool annotations and MCP output schemas on every tool. (#219)
- `--only` and `--exclude` to control which tools are exposed. (#71, #72)
- Guidance moved from static "tools" to MCP prompts: `debuggerMode`,
  `auditMode`, `nextjsSeoAudit`.
- A console capture mode that wraps the page's console instead of attaching the
  debugger — no "started debugging" banner, and it works in Firefox. (#115)
- 250 tests: unit, integration, and end-to-end suites that load the real
  extension into a real Chromium and assert the whole capture path, drive the
  full MCP client -> server -> connector -> extension -> page chain, run real
  Lighthouse audits, exercise the shared-connector attach path over HTTP, drive
  the DevTools panel UI in the real extension origin, and cover the injected
  console-capture mode used where chrome.debugger is unavailable.
- `engines: node >=22.19`, so an unsupported runtime fails at install with a
  clear message. (#18, #2, #15)

### Changed

- Node 22.19 is now the minimum.
- `@modelcontextprotocol/sdk` 1.5 → 1.30; Express 4 → 5; Lighthouse 11 → 13;
  `ws` 8.18 → 8.21. `npm audit` reports zero vulnerabilities, down from 22
  across the two packages.
- Dropped `body-parser`, `node-fetch`, `llm-cost` and `puppeteer-core`; Express
  and Node provide the first two, the third was unused, and Lighthouse is
  driven through `chrome-launcher` directly.
- The extension has no background service worker. Everything runs in the
  DevTools page, which removes the Manifest V3 worker eviction that caused
  "Could not establish connection. Receiving end does not exist." (#147, #141, #184)
- The extension requests fewer permissions: `<all_urls>` and `tabs` are no
  longer in the default set, and cookie access is optional.
- Capture starts when DevTools opens, rather than when the panel is selected.
- Auto-paste into Cursor removed — screenshots reach the model directly now, and
  auto-paste was the mechanism behind the RCE.

## 1.2.1 and earlier

See the repository history. **These versions are affected by the critical
vulnerabilities described in [SECURITY.md](SECURITY.md) and should not be used.**
