# @agentdeskai/browser-tools-server

Standalone connector for BrowserTools MCP.

**Most people do not need this package.** Since 2.0 the connector is embedded in
`@agentdeskai/browser-tools-mcp`, so a normal setup is a single process.

Run this only when several MCP clients should share one browser session:

```bash
npx @agentdeskai/browser-tools-server
```

Every `browser-tools-mcp` process started afterwards attaches to it
automatically instead of starting its own.

Full documentation: https://github.com/AgentDeskAI/browser-tools-mcp
