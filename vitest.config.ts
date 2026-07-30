import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["browser-tools-mcp/test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["browser-tools-mcp/test/integration/**/*.test.ts"],
          environment: "node",
          // Integration tests bind real loopback sockets and spawn the MCP
          // server over stdio; they must not share module state.
          pool: "forks",
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["browser-tools-mcp/test/e2e/**/*.test.ts"],
          environment: "node",
          pool: "forks",
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
