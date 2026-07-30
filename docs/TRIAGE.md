# Pull request and issue triage

Disposition for every open PR and issue as of the 2.0 rewrite, and the commands
to act on them.

**Nothing here has been applied.** Merging, closing and commenting are
outward-facing actions on a public repository with 7k stars, so they are left
for a maintainer to run deliberately.

Because 2.0 rewrote all three components, no 1.x-era PR merges cleanly. Where a
PR had a good idea, that idea was reimplemented against the new code and is
noted below — those authors deserve credit in the release notes even though
their commits do not appear.

## Pull requests

### Implemented in 2.0 — close with credit

| PR | Author | Idea | Where it landed |
| --- | --- | --- | --- |
| #235 | mirageN1349 | Keep MCP stdio logs off stdout | `src/util/logger.ts` writes only to stderr; asserted by `test/integration/mcp-stdio.test.ts` |
| #223 | ymrdf | Same fix, duplicate of #222 | as above |
| #222 | pntgoswami18 | Same fix, best root-cause writeup of the three | as above |
| #194 | lukasvdberk | Return the screenshot as an image | `takeScreenshot` returns an image content block |
| #219 | bryankthompson | Tool annotations | Every tool declares annotations and an output schema |
| #218 | yj1438 | Keyword filters on log tools | `keywords`, `urlKeywords`, `bodyKeywords`, plus `limit`/`offset`; the crash on absent fields is covered by a regression test |
| #185 | isaiahbjork | Browser refresh tool | `refreshBrowser` |
| #137 | zzh948498 | `stringSizeLimit` had no effect on selected elements | Applied in the extension's selection handler |
| #150 | Jinsoo1004 | Delete committed `.DS_Store` | Deleted, and `.gitignore` covers it |
| #49 | thepushkarp | Cookies / localStorage / sessionStorage | `getBrowserStorage`, values withheld by default, cookies behind an optional permission |
| #72 | bmacer | Let users choose which tools are exposed | `--only` / `--exclude` |
| #85 | TargiX | Screenshots fail with DevTools undocked | Capture moved to `Page.captureScreenshot`, which needs no window focus |
| #115 (issue) / #215 | rogeriochaves | Firefox support | Single cross-browser codebase: `browser`/`chrome` shim, MV3 with `browser_specific_settings`, and a console capture mode that does not need `chrome.debugger` |
| #236 | wer416182-afk | npm package metadata | `repository`, `bugs`, `homepage` on both packages |
| #237 | xianzuyang9-blip | Handle `--version` / `--help` before startup | `src/cli.ts`, with the version read from `package.json` rather than hardcoded |

Suggested comment when closing:

> Thanks for this — the idea shipped in 2.0.0, reimplemented against the
> rewritten codebase (see CHANGELOG). Closing since the diff no longer applies,
> but you are credited in the release notes.

```bash
for pr in 235 223 222 194 219 218 185 137 150 49 72 85 236 237; do
  gh pr close "$pr" --comment "Thanks for this — the idea shipped in 2.0.0, reimplemented against the rewritten codebase (see CHANGELOG.md). Closing since the diff no longer applies to the new code, but you are credited in the release notes."
done
```

### Close as spam — no comment beyond a brief note

| PR | Author | Why |
| --- | --- | --- |
| #203 | lwsinclair | MseeP.ai badge. Mass campaign across MCP repos; the remotely-hosted badge image tracks every README view. The "security findings" in the body are boilerplate. |
| #167 | lwsinclair | The same badge, filed a second time. |
| #176 | AI-Agent-Hub | deepnlp.org "MCP marketplace" links plus a plain-HTTP tracking badge. |

```bash
gh pr close 203 167 176 --comment "Closing: unsolicited third-party promotional links. Not something this project will carry."
```

### Close as superseded

| PR | Why |
| --- | --- |
| #187 | Auto-spawned a detached server process from the MCP server, broke the single-connection model, announced a fictitious v1.3.0 in the README, and shipped the author's personal Windows paths. Its two good ideas — configurable screenshot path and capture with DevTools closed — are both in 2.0 by other means. |
| #178 | ~20 lines of Chromium detection inside an 800-line reformat. 2.0 uses `chrome-launcher`, which handles Chromium and ungoogled-chromium already. |
| #73 | 17 months stale and conflicting; imposed pnpm, husky and a house style. 2.0 picks its own toolchain. |
| #215 | Superseded by cross-browser support in the single extension codebase, which avoids maintaining a duplicate Firefox tree. Worth a personal note — this was substantial, competent work. |

## Issues

| Issue | Action | Why |
| --- | --- | --- |
| #224 | **Close as fixed in 2.0.0**, after publishing the advisory | Canonical RCE report. Fixed by design change, not a patch. |
| #232 | Close as duplicate of #224; respond about the CVE request | Same vulnerability, formally written. |
| #233 | Close as duplicate of #224 | Vendor scan of the same issue. |
| #228 | Close as fixed | Header and secret redaction implemented; `wipeLogs` is annotated destructive. |
| #239 | Close as fixed | stdout no longer carries anything but JSON-RPC; regression test added. |
| #226 | Close as fixed | Discovery no longer blocks startup, and the second process is gone entirely. |
| #225 | Close as misfiled | The stack trace is entirely `@bytebase/dbhub`; nothing from this repo. |
| #234 | Close as promotional | Findings behind a signup wall, no actionable specifics. |

Also worth closing with a pointer to 2.0: the recurring themes from the ~160
closed issues — server discovery (#95, #91, #86, #147), screenshots with
undocked DevTools (#79, #189, #81), "Receiving end does not exist" (#147, #141,
#184), stdio corruption (#103), screenshots not reaching the model (#200, #52,
#181, #111), and tool selection (#71).

## Release checklist

1. Merge this branch.
2. Tag and publish `@agentdeskai/browser-tools-mcp@2.0.0` and
   `@agentdeskai/browser-tools-server@2.0.0`.
3. Deprecate the vulnerable range:
   ```bash
   npm deprecate '@agentdeskai/browser-tools-mcp@<2.0.0' \
     'Critical RCE (GHSA pending). Upgrade to 2.0.0.'
   npm deprecate '@agentdeskai/browser-tools-server@<2.0.0' \
     'Critical RCE (GHSA pending). Upgrade to 2.0.0.'
   ```
4. Publish a GitHub Security Advisory from the content in `SECURITY.md` and
   request a CVE, which #232 explicitly asked for.
5. Close the PRs and issues above.
6. Consider publishing the extension to the Chrome Web Store — loading unpacked
   is a real adoption barrier, and a signed listing also removes the "is this
   the real extension" question that a security advisory tends to raise.
