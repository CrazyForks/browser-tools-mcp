import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ConnectorClient } from "./client.js";
import { PROMPTS } from "./prompts.js";
import { createLogger } from "../util/logger.js";
import { AUDIT_CATEGORIES, type AuditCategory } from "../lighthouse/types.js";

const log = createLogger("mcp");

export const SERVER_NAME = "browser-tools-mcp";
export const SERVER_VERSION = "2.0.0";

export interface McpServerOptions {
  client: ConnectorClient;
  /** When set, only these tools are exposed. Unknown names are ignored. */
  enabledTools?: string[];
  /** Tools to hide. Applied after enabledTools. */
  disabledTools?: string[];
}

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ToolContent = TextContent | ImageContent;

type ToolResult = {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Spec-compliant success result: structured data plus its serialisation as
 * text, so clients that only render content blocks still see the payload.
 */
function ok(structured: Record<string, unknown>, extraContent: ToolContent[] = []): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }, ...extraContent],
    structuredContent: structured,
  };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  log.warn("Tool call failed:", message);
  return { content: [{ type: "text", text: message }], isError: true };
}

const queryOutputShape = {
  entries: z.array(z.record(z.string(), z.unknown())),
  total: z.number().int().describe("Entries matching the filter before paging"),
  returned: z.number().int().describe("Entries actually included"),
  truncated: z.boolean().describe("True when some matching entries were withheld"),
};

const pagingInputShape = {
  limit: z.number().int().min(1).max(1000).optional().describe("Maximum entries to return"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("How many of the most recent entries to skip, for paging backwards"),
};

const keywordInput = z
  .array(z.string())
  .optional()
  .describe("Case-insensitive substrings; an entry matches if it contains any of them");

const auditOutputShape = {
  category: z.string(),
  score: z.number().nullable().describe("0-100, or null if the category was not measured"),
  metadata: z.record(z.string(), z.unknown()),
  summary: z.record(z.string(), z.number()),
  issues: z.array(z.record(z.string(), z.unknown())),
  groups: z.record(z.string(), z.unknown()).optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
};

interface ToolDefinition {
  name: string;
  register(server: McpServer, client: ConnectorClient): void;
}

function auditTool(
  name: string,
  category: AuditCategory,
  title: string,
  description: string
): ToolDefinition {
  return {
    name,
    register(server, client) {
      server.registerTool(
        name,
        {
          title,
          description,
          inputSchema: {
            url: z
              .string()
              .optional()
              .describe("Page to audit. Defaults to the page currently open in the browser."),
          },
          outputSchema: auditOutputShape,
          annotations: {
            title,
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async ({ url }) => {
          try {
            const report = await client.audit(category, url ? { url } : {});
            return ok(report as unknown as Record<string, unknown>);
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  };
}

const TOOLS: ToolDefinition[] = [
  {
    name: "getConsoleLogs",
    register(server, client) {
      server.registerTool(
        "getConsoleLogs",
        {
          title: "Get console logs",
          description:
            "Console output captured from the page currently open in the browser. Use keywords and limit to keep responses small — an unfiltered read can be large.",
          inputSchema: { keywords: keywordInput, ...pagingInputShape },
          outputSchema: queryOutputShape,
          annotations: {
            title: "Get console logs",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (args) => {
          try {
            return ok(await client.console({ ...args }) as unknown as Record<string, unknown>);
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getConsoleErrors",
    register(server, client) {
      server.registerTool(
        "getConsoleErrors",
        {
          title: "Get console errors",
          description:
            "Only error-level console output and uncaught exceptions from the current page. Start here when diagnosing a failure.",
          inputSchema: { keywords: keywordInput, ...pagingInputShape },
          outputSchema: queryOutputShape,
          annotations: {
            title: "Get console errors",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (args) => {
          try {
            return ok(
              (await client.console({ ...args, errorsOnly: true })) as unknown as Record<string, unknown>
            );
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getNetworkLogs",
    register(server, client) {
      server.registerTool(
        "getNetworkLogs",
        {
          title: "Get network requests",
          description:
            "XHR and fetch requests captured from the current page, including status and timing. Credential headers are redacted.",
          inputSchema: {
            urlKeywords: z.array(z.string()).optional().describe("Match against the request URL"),
            bodyKeywords: z
              .array(z.string())
              .optional()
              .describe("Match against the request or response body"),
            ...pagingInputShape,
          },
          outputSchema: queryOutputShape,
          annotations: {
            title: "Get network requests",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (args) => {
          try {
            return ok((await client.network({ ...args })) as unknown as Record<string, unknown>);
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getNetworkErrors",
    register(server, client) {
      server.registerTool(
        "getNetworkErrors",
        {
          title: "Get failed network requests",
          description:
            "Only requests that failed or returned a 4xx/5xx status. An empty result means there were no failures, which is a success, not an error.",
          inputSchema: {
            urlKeywords: z.array(z.string()).optional().describe("Match against the request URL"),
            ...pagingInputShape,
          },
          outputSchema: queryOutputShape,
          annotations: {
            title: "Get failed network requests",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (args) => {
          try {
            return ok(
              (await client.network({ ...args, errorsOnly: true })) as unknown as Record<string, unknown>
            );
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getSelectedElement",
    register(server, client) {
      server.registerTool(
        "getSelectedElement",
        {
          title: "Get selected element",
          description:
            "The DOM element the user has selected in the Chrome DevTools Elements panel, with its attributes and markup.",
          outputSchema: { element: z.record(z.string(), z.unknown()).nullable() },
          annotations: {
            title: "Get selected element",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async () => {
          try {
            const element = (await client.selectedElement()) as Record<string, unknown> | null;
            return ok({ element });
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getPageInfo",
    register(server, client) {
      server.registerTool(
        "getPageInfo",
        {
          title: "Get current page",
          description:
            "Which page the browser is currently on. Call this before reading telemetry so you know what the logs describe.",
          outputSchema: {
            url: z.string(),
            tabId: z.union([z.number(), z.string()]).nullable(),
            extensionConnected: z.boolean(),
          },
          annotations: {
            title: "Get current page",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async () => {
          try {
            return ok((await client.page()) as unknown as Record<string, unknown>);
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getConnectionStatus",
    register(server, client) {
      server.registerTool(
        "getConnectionStatus",
        {
          title: "Check browser connection",
          description:
            "Whether the Chrome extension is connected and how much telemetry has been captured. Call this first when something returns nothing.",
          outputSchema: {
            version: z.string(),
            extensionConnected: z.boolean(),
            connections: z.number().int(),
            screenshotDir: z.string(),
            counts: z.record(z.string(), z.number()),
          },
          annotations: {
            title: "Check browser connection",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async () => {
          try {
            return ok((await client.status()) as unknown as Record<string, unknown>);
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "takeScreenshot",
    register(server, client) {
      server.registerTool(
        "takeScreenshot",
        {
          title: "Take a screenshot",
          description:
            "Captures the visible area of the inspected tab and returns the image directly, plus the path it was saved to.",
          inputSchema: {
            name: z
              .string()
              .optional()
              .describe("Filename to save as, relative to the screenshot directory"),
          },
          outputSchema: {
            path: z.string(),
            name: z.string(),
            mimeType: z.string(),
            bytes: z.number().int(),
            imageIncluded: z.boolean(),
          },
          annotations: {
            title: "Take a screenshot",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        async ({ name }) => {
          try {
            const result = await client.screenshot(name ? { name } : {});
            const base64 = result.data.replace(/^data:[^;]+;base64,/, "");
            const structured = {
              path: result.path,
              name: result.name,
              mimeType: result.mimeType,
              bytes: result.bytes,
              imageIncluded: result.withinBudget,
            };

            // An oversized image is left on disk rather than inlined: it would
            // swamp the context window, and newer MCP stdio transports drop the
            // connection outright past their read buffer.
            if (!result.withinBudget) {
              return ok(structured, [
                {
                  type: "text",
                  text:
                    `The screenshot is ${Math.round(result.bytes / 1024)} KB, too large to include here. ` +
                    `It was saved to ${result.path}. Lower screenshotMaxBytes or reduce the browser window size to get an inline image.`,
                },
              ]);
            }

            return ok(structured, [
              { type: "image", data: base64, mimeType: result.mimeType },
            ]);
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "refreshBrowser",
    register(server, client) {
      server.registerTool(
        "refreshBrowser",
        {
          title: "Reload the page",
          description:
            "Reloads the inspected tab. Useful for capturing a clean reproduction after calling wipeLogs.",
          outputSchema: { ok: z.boolean() },
          annotations: {
            title: "Reload the page",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        async () => {
          try {
            await client.refresh();
            return ok({ ok: true });
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "getBrowserStorage",
    register(server, client) {
      server.registerTool(
        "getBrowserStorage",
        {
          title: "Inspect browser storage",
          description:
            "Lists localStorage, sessionStorage and cookie entries for the current page. Values are withheld unless includeValues is set, because they routinely contain session tokens.",
          inputSchema: {
            kinds: z
              .array(z.enum(["localStorage", "sessionStorage", "cookies"]))
              .optional()
              .describe("Which stores to read. Defaults to localStorage and sessionStorage."),
            includeValues: z
              .boolean()
              .optional()
              .describe(
                "Return the actual values. Only set this when the user has asked for them — these are credentials."
              ),
          },
          outputSchema: {
            storage: z.record(z.string(), z.unknown()),
            includedValues: z.boolean(),
          },
          annotations: {
            title: "Inspect browser storage",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async ({ kinds, includeValues }) => {
          try {
            const requested = kinds?.length ? kinds : ["localStorage", "sessionStorage"];
            const raw = await client.storage(requested);
            return ok({
              storage: includeValues ? raw : summariseStorage(raw),
              includedValues: Boolean(includeValues),
            });
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  {
    name: "wipeLogs",
    register(server, client) {
      server.registerTool(
        "wipeLogs",
        {
          title: "Clear captured telemetry",
          description:
            "Discards all captured console and network entries. Use before reproducing a problem so the next read contains only relevant output.",
          outputSchema: { ok: z.boolean() },
          annotations: {
            title: "Clear captured telemetry",
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async () => {
          try {
            await client.wipe();
            return ok({ ok: true });
          } catch (error) {
            return fail(error);
          }
        }
      );
    },
  },
  auditTool(
    "runAccessibilityAudit",
    "accessibility",
    "Run an accessibility audit",
    "Lighthouse accessibility audit of the current page: contrast, labels, semantics and screen-reader support. Takes up to a minute and launches a separate headless browser."
  ),
  auditTool(
    "runPerformanceAudit",
    "performance",
    "Run a performance audit",
    "Lighthouse performance audit of the current page, including Core Web Vitals. Takes up to a minute and launches a separate headless browser."
  ),
  auditTool(
    "runSEOAudit",
    "seo",
    "Run an SEO audit",
    "Lighthouse SEO audit of the current page: metadata, indexability and crawlability. Takes up to a minute and launches a separate headless browser."
  ),
  auditTool(
    "runBestPracticesAudit",
    "best-practices",
    "Run a best-practices audit",
    "Lighthouse best-practices audit of the current page: security, deprecated APIs and modern-web hygiene. Takes up to a minute and launches a separate headless browser."
  ),
];

export const ALL_TOOL_NAMES = TOOLS.map((tool) => tool.name);

/** Hides values while still showing which keys exist. */
function summariseStorage(storage: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [kind, value] of Object.entries(storage)) {
    if (Array.isArray(value)) {
      const names = value
        .map((item) =>
          item && typeof item === "object" && "name" in item ? String((item as any).name) : null
        )
        .filter((name): name is string => Boolean(name));
      out[kind] = { names, count: value.length };
    } else if (value && typeof value === "object") {
      const keys = Object.keys(value as Record<string, unknown>);
      out[kind] = { keys, count: keys.length };
    } else {
      out[kind] = { keys: [], count: 0 };
    }
  }

  return out;
}

export function createMcpServer(options: McpServerOptions): {
  server: McpServer;
  toolNames: string[];
} {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, prompts: {} } }
  );

  const enabled = new Set(options.enabledTools ?? ALL_TOOL_NAMES);
  const disabled = new Set(options.disabledTools ?? []);

  const selected = TOOLS.filter((tool) => enabled.has(tool.name) && !disabled.has(tool.name));

  const unknown = (options.enabledTools ?? []).filter(
    (name) => !ALL_TOOL_NAMES.includes(name)
  );
  if (unknown.length > 0) {
    log.warn(`Ignoring unknown tool name(s) in filter: ${unknown.join(", ")}`);
  }

  for (const tool of selected) tool.register(server, options.client);

  for (const prompt of PROMPTS) {
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description },
      () => ({
        messages: [{ role: "user", content: { type: "text", text: prompt.text } }],
      })
    );
  }

  log.info(`Registered ${selected.length} tools and ${PROMPTS.length} prompts`);

  return { server, toolNames: selected.map((tool) => tool.name) };
}

export { AUDIT_CATEGORIES };
