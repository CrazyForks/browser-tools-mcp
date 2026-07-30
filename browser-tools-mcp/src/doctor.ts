import os from "node:os";
import fs from "node:fs";
import { createRuntime } from "./runtime.js";
import { readSessionFile, sessionFilePath } from "./util/session.js";
import { getDefaultScreenshotDir } from "./util/paths.js";
import { readPackageVersion, type CliOptions } from "./cli.js";

const MINIMUM_NODE_MAJOR = 22;

function line(label: string, value: string): string {
  return `${label.padEnd(22)} ${value}\n`;
}

/**
 * Prints what is and is not working locally.
 *
 * Roughly a fifth of the issues filed against 1.x were environment problems —
 * old Node, the connector not running, the extension never connected — that a
 * single command could have answered without a human.
 */
export async function runDoctor(options: CliOptions): Promise<number> {
  let out = "BrowserTools MCP — setup check\n\n";
  let problems = 0;

  out += line("Version", readPackageVersion());

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const nodeOk = nodeMajor >= MINIMUM_NODE_MAJOR;
  out += line("Node", `v${process.versions.node} ${nodeOk ? "(ok)" : "(too old)"}`);
  if (!nodeOk) {
    problems += 1;
    out += `  ! Node ${MINIMUM_NODE_MAJOR} or newer is required. Upgrade Node, and if you use nvm or asdf make sure your MCP client inherits the same version.\n`;
  }

  out += line("Platform", `${os.platform()} ${os.arch()}`);

  const screenshotDir = options.screenshotDir ?? getDefaultScreenshotDir();
  out += line("Screenshot directory", screenshotDir);

  const session = readSessionFile();
  out += line(
    "Session file",
    session ? `${sessionFilePath()} (port ${session.port}, pid ${session.pid})` : "none"
  );

  const runtime = await createRuntime(options);
  out += line("Connector", runtime.degradedReason ? `failed — ${runtime.degradedReason}` : runtime.description);
  if (runtime.degradedReason) problems += 1;

  try {
    const status = await runtime.client.status();
    out += line("Chrome extension", status.extensionConnected ? "connected" : "not connected");
    if (!status.extensionConnected) {
      problems += 1;
      out +=
        "  ! Open Chrome DevTools (F12) on the page you want to inspect. Capture starts as\n" +
        "    soon as DevTools is open — you do not need to select the BrowserTools panel.\n" +
        "    If the panel is missing entirely, load the extension from the chrome-extension\n" +
        "    directory at chrome://extensions with Developer mode enabled.\n";
    } else {
      out += line("Captured entries", `${status.counts.console} console, ${status.counts.network} network`);
    }
  } catch (error) {
    problems += 1;
    out += line("Chrome extension", "unknown");
    out += `  ! Could not query the connector: ${error instanceof Error ? error.message : String(error)}\n`;
  }

  try {
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.accessSync(screenshotDir, fs.constants.W_OK);
    out += line("Screenshot writable", "yes");
  } catch {
    problems += 1;
    out += line("Screenshot writable", "no");
    out += `  ! Cannot write to ${screenshotDir}. Set BROWSER_TOOLS_SCREENSHOT_DIR to a writable path.\n`;
  }

  out += `\n${problems === 0 ? "Everything looks ready." : `${problems} problem(s) found.`}\n`;
  process.stdout.write(out);

  await runtime.close();
  return problems === 0 ? 0 : 1;
}
