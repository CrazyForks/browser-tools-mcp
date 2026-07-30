#!/usr/bin/env node
/**
 * Compatibility entry point.
 *
 * Since 2.0.0 the connector is embedded in the MCP server, so the usual setup
 * is a single process and this package is not required. It remains published so
 * that existing `npx @agentdeskai/browser-tools-server` instructions keep
 * working, and for the case where several MCP clients share one browser
 * session: start this once, and every client will attach to it.
 */
import "@agentdeskai/browser-tools-mcp/dist/connector-bin.js";
