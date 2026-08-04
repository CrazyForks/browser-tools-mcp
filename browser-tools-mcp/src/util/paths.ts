import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/** Thrown when a caller-supplied path would escape the screenshot sandbox. */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

const WSL_DISTRIBUTIONS = [
  "Ubuntu",
  "Debian",
  "kali",
  "openSUSE",
  "SLES",
  "Fedora",
  "Alpine",
  "Arch",
];

/**
 * Normalises a path written on one platform for use on another. In practice
 * this is about Windows hosts driving a server running under WSL, which is a
 * recurring source of "screenshot saved somewhere I can't find it" reports.
 */
export function convertPathForPlatform(
  inputPath: string,
  platform: NodeJS.Platform = os.platform()
): string {
  if (!inputPath) return inputPath;

  if (platform === "win32") {
    return inputPath.replace(/\//g, "\\");
  }

  if (platform !== "linux" && platform !== "darwin") return inputPath;

  // Windows drive letter, e.g. C:\Users\ted — checked before the generic
  // backslash handling below, which would otherwise leave the drive prefix in
  // place and produce a path that does not exist on a POSIX host.
  if (/^[A-Za-z]:[\\/]/.test(inputPath)) {
    return inputPath.replace(/^[A-Za-z]:[\\/]/, "/").replace(/\\/g, "/");
  }

  if (!inputPath.includes("\\")) return inputPath;

  const isWslPath =
    inputPath.includes("wsl.localhost") || inputPath.includes("wsl$");

  if (isWslPath) {
    const parts = inputPath.split("\\").filter((part) => part.length > 0);

    const distIndex = parts.findIndex((part) =>
      WSL_DISTRIBUTIONS.some((dist) => dist.toLowerCase() === part.toLowerCase())
    );
    if (distIndex !== -1 && distIndex + 1 < parts.length) {
      return "/" + parts.slice(distIndex + 1).join("/");
    }

    // Unknown distribution: skip the \\wsl.localhost\<distro> prefix positionally.
    const wslIndex = parts.findIndex((part) => {
      const lower = part.toLowerCase();
      return lower === "wsl.localhost" || lower === "wsl$";
    });
    if (wslIndex !== -1 && wslIndex + 2 <= parts.length - 1) {
      return "/" + parts.slice(wslIndex + 2).join("/");
    }
  }

  // Collapse the leading \\ of a UNC path to a single root slash.
  return inputPath.replace(/^\\\\/, "/").replace(/\\/g, "/");
}

export function convertPathForCurrentPlatform(inputPath: string): string {
  return convertPathForPlatform(inputPath, os.platform());
}

/** Default directory screenshots are written to. */
export function getDefaultScreenshotDir(): string {
  return path.join(os.homedir(), "Downloads", "mcp-screenshots");
}

/**
 * Characters permitted in a caller-supplied screenshot name.
 *
 * Deliberately restrictive. The previous implementation accepted an arbitrary
 * absolute path over an unauthenticated socket and interpolated it into a
 * shell command, which was the root of the command-injection vulnerability.
 * Nothing outside this set can escape a shell word or a directory.
 */
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * Resolves a caller-supplied relative name inside `baseDir`, refusing anything
 * that could escape it. Callers never choose the base directory.
 */
export function resolveSafeScreenshotPath(
  baseDir: string,
  relativeName: string
): string {
  if (typeof relativeName !== "string" || relativeName.length === 0) {
    throw new UnsafePathError("Screenshot name must be a non-empty string");
  }
  if (relativeName.includes("\u0000")) {
    throw new UnsafePathError("Screenshot name must not contain null bytes");
  }
  if (path.isAbsolute(relativeName) || /^[A-Za-z]:/.test(relativeName)) {
    throw new UnsafePathError("Screenshot name must be relative");
  }
  if (!SAFE_RELATIVE_PATH.test(relativeName)) {
    throw new UnsafePathError(
      `Screenshot name contains unsupported characters: ${JSON.stringify(relativeName)}`
    );
  }

  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, relativeName);

  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new UnsafePathError("Screenshot name must stay inside the screenshot directory");
  }

  return resolved;
}

let filenameCounter = 0;

/**
 * Builds a unique, sortable, shell-safe screenshot filename. Colons are
 * stripped so the name survives every platform and never needs quoting.
 */
export function screenshotFilename(now: Date = new Date(), extension = "png"): string {
  const stamp = now.toISOString().replace(/:/g, "-");
  const counter = (filenameCounter++ % 0x1000).toString(16).padStart(3, "0");
  const random = crypto.randomBytes(2).toString("hex").slice(0, 3);
  return `screenshot-${stamp}-${random}${counter}.${extension}`;
}
