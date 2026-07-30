#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { parseCli, helpText, readPackageVersion } from "./cli.js";
import { createRuntime } from "./runtime.js";
import { createMcpServer } from "./mcp/server.js";
import { runDoctor } from "./doctor.js";
import { createLogger, setLogLevel } from "./util/logger.js";

const log = createLogger("main");

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));

  // Metadata flags answer before anything is started or bound.
  if (options.showVersion) {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }
  if (options.showHelp) {
    process.stdout.write(helpText());
    return;
  }
  if (options.doctor) {
    const exitCode = await runDoctor(options);
    process.exitCode = exitCode;
    return;
  }

  const runtime = await createRuntime(options);
  log.info(`Telemetry source: ${runtime.description}`);

  const { server, toolNames } = createMcpServer({
    client: runtime.client,
    ...(options.enabledTools ? { enabledTools: options.enabledTools } : {}),
    ...(options.disabledTools ? { disabledTools: options.disabledTools } : {}),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`MCP server ready with tools: ${toolNames.join(", ")}`);

  if (runtime.degradedReason) {
    log.warn(
      "Running without a connector — tool calls will explain the problem rather than return data."
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down`);
    try {
      await server.close();
    } catch (error) {
      log.warn("Error closing MCP server:", error);
    }
    try {
      await runtime.close();
    } catch (error) {
      log.warn("Error closing connector:", error);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("close", () => void shutdown("stdin close"));
}

// Nothing may write to stdout except the transport, so failures report on
// stderr and exit non-zero.
main().catch((error) => {
  setLogLevel("error");
  log.error("Fatal error during startup:", error);
  process.exit(1);
});
