# Changelog

## Unreleased

### Added

- **`--verbose` prints each captured entry as it arrives.** Without it the
  connector reports only connect and disconnect, so there was no way to tell a
  working capture from a silent one without querying the API. Output goes to
  stderr, so it is safe to enable on the MCP server without corrupting the
  JSON-RPC stream, and values are printed after redaction.
- **Large payloads are MCP resources now, not inlined text.** Full console and
  network history, network traffic as a HAR 1.2 file, captured screenshots, and
  the unabridged Lighthouse result behind an audit summary are all readable at
  `browser-tools://…` URIs. Tools attach a `resource_link` — when a log read was
  cut short, alongside every network read for the HAR, and always for a
  screenshot, which is the only route to one too large to inline. Only the 20
  most recent full audit reports are kept on disk.
- **Multi-tab support.** Every tab with DevTools open is tracked separately,
  telemetry is attributed to the tab that produced it, and retention is per tab
  so a noisy page cannot evict a quiet one's history. New `listBrowserTabs`
  tool; every other tool takes an optional `tabId`, and the log tools take
  `allTabs`. Results carry `tabId`, `url` and `otherTabs` so a wrong-tab answer
  is visible rather than silent. No extension change is required — it already
  reports its tab id.

### Fixed

- **Credentials could survive redaction when they were longer than the
  truncation limit.** Found by manual testing against a live
  Clerk-authenticated app: a JWT and several session identifiers reached the
  store intact. Two causes, both fixed. The extension truncated strings before
  sending, so a token longer than `stringSizeLimit` arrived as a lone header
  segment that no longer matched the JWT pattern; and there was no pattern for
  vendor session identifiers at all, which appeared in request URLs as well as
  response bodies. Scrubbing now happens **in the browser, before truncation**,
  so secrets no longer cross the socket at all, and the server keeps its own
  pass as defence in depth.
- **A reconnecting background tab no longer steals targeting.** A tab that is
  timer-throttled, misses the heartbeat and reconnects looked identical to a
  user opening DevTools on a new tab, so it silently became the target of
  screenshots and reads. The connector now remembers which tab ids it has seen,
  so only genuinely new tabs take over.
- A tab navigating in the background no longer takes over either.
- A response can only resolve the request it was sent for, on the connection it
  was sent to; previously any tab could answer another tab's request.
- Closing a DevTools window now fails its in-flight requests immediately instead
  of leaving the caller waiting for the full timeout.

- **Screenshots are held to a byte budget.** A viewport capture of visually
  dense content measured 13.3 MB of base64 on a 1440p retina display and
  17.9 MB on an ultrawide — more than a model's context can take, and past the
  10 MB read buffer newer MCP stdio transports enforce, which severs the
  connection. The browser now degrades PNG to JPEG and then downscales until the
  capture fits `screenshotMaxBytes` (3 MB by default, configurable). An image
  that still cannot fit is written to disk and its path returned rather than
  inlined.
- Screenshots carry their real media type end to end, so a capture that fell
  back to JPEG is saved as `.jpg` with JPEG bytes instead of being mislabelled
  `.png`, and the MCP image block reports the correct `mimeType`.
- The connector no longer waits on lingering sockets when shutting down, so its
  port is released promptly instead of staying bound after `close()` resolves.

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
