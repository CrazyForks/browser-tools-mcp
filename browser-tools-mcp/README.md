# @agentdeskai/browser-tools-mcp

MCP server exposing live browser telemetry — console output, network requests,
screenshots and Lighthouse audits — from your real Chrome session.

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

This package embeds the browser connector, so it is the only process you need to
run. Pair it with the Chrome extension from the
[repository](https://github.com/AgentDeskAI/browser-tools-mcp).

Requires Node 22.19 or newer. Run with `--doctor` to check your setup, or
`--help` for all options.

Full documentation, tool reference and security notes:
https://github.com/AgentDeskAI/browser-tools-mcp
