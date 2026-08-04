import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ConnectorClient } from "./client.js";
import { buildHar } from "../util/har.js";
import type { TabId } from "../connector/store.js";

/**
 * Large payloads live behind MCP resources instead of being inlined.
 *
 * A full HAR, a complete console history or an unabridged Lighthouse result is
 * exactly what you want when something needs proper examination, and exactly
 * what should never be pushed into a context window uninvited. Tools return a
 * `resource_link` so the agent can fetch the whole thing deliberately.
 */

export const RESOURCE_SCHEME = "browser-tools";

/** "all" reads across every tab; anything else names one. */
export function scopeToOptions(scope: string): { tabId?: TabId; allTabs?: boolean } {
  if (!scope || scope === "all") return { allTabs: true };
  const asNumber = Number(scope);
  return { tabId: Number.isFinite(asNumber) && scope.trim() !== "" ? asNumber : scope };
}

export function consoleUri(tabId: TabId | null | undefined): string {
  return `${RESOURCE_SCHEME}://console/${tabId ?? "all"}`;
}

export function networkUri(tabId: TabId | null | undefined): string {
  return `${RESOURCE_SCHEME}://network/${tabId ?? "all"}`;
}

export function harUri(tabId: TabId | null | undefined): string {
  return `${RESOURCE_SCHEME}://har/${tabId ?? "all"}`;
}

export function screenshotUri(name: string): string {
  return `${RESOURCE_SCHEME}://screenshot/${name}`;
}

export function auditUri(reportId: string): string {
  return `${RESOURCE_SCHEME}://audit/${reportId}`;
}

function json(uri: URL, payload: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/** Template variables arrive as string or string[] depending on the match. */
function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export function registerResources(server: McpServer, client: ConnectorClient): void {
  server.registerResource(
    "console-history",
    new ResourceTemplate(`${RESOURCE_SCHEME}://console/{scope}`, { list: undefined }),
    {
      title: "Full console history",
      description:
        "Every console entry captured for a tab, with no per-call size budget applied. Use 'all' for every tab, or a tabId from listBrowserTabs.",
      mimeType: "application/json",
    },
    async (uri, variables) => json(uri, await client.exportConsole(scopeToOptions(one(variables["scope"]))))
  );

  server.registerResource(
    "network-history",
    new ResourceTemplate(`${RESOURCE_SCHEME}://network/{scope}`, { list: undefined }),
    {
      title: "Full network history",
      description:
        "Every captured request for a tab, including bodies, with no per-call size budget applied. Use 'all' for every tab, or a tabId.",
      mimeType: "application/json",
    },
    async (uri, variables) => json(uri, await client.exportNetwork(scopeToOptions(one(variables["scope"]))))
  );

  server.registerResource(
    "network-har",
    new ResourceTemplate(`${RESOURCE_SCHEME}://har/{scope}`, { list: undefined }),
    {
      title: "Network activity as HAR",
      description:
        "Captured network activity in HTTP Archive (HAR 1.2) format, readable by browsers and HTTP tooling. Use 'all' for every tab, or a tabId.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const exported = await client.exportNetwork(scopeToOptions(one(variables["scope"])));
      return json(uri, buildHar(exported.entries));
    }
  );

  server.registerResource(
    "screenshot",
    new ResourceTemplate(`${RESOURCE_SCHEME}://screenshot/{name}`, { list: undefined }),
    {
      title: "Captured screenshot",
      description:
        "A screenshot previously taken with takeScreenshot, by the name reported in its result.",
    },
    async (uri, variables) => {
      const artifact = await client.readArtifact("screenshot", decodeURIComponent(one(variables["name"])));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: artifact.mimeType,
            ...(artifact.blob !== undefined ? { blob: artifact.blob } : { text: artifact.text ?? "" }),
          },
        ],
      };
    }
  );

  server.registerResource(
    "audit-report",
    new ResourceTemplate(`${RESOURCE_SCHEME}://audit/{reportId}`, { list: undefined }),
    {
      title: "Full Lighthouse report",
      description:
        "The unabridged Lighthouse result behind an audit summary, by the reportId in that summary. Large — read it only when the summary is not enough.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const artifact = await client.readArtifact("audit", decodeURIComponent(one(variables["reportId"])));
      return {
        contents: [
          { uri: uri.href, mimeType: artifact.mimeType, text: artifact.text ?? "" },
        ],
      };
    }
  );
}
