import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  convertPathForPlatform,
  resolveSafeScreenshotPath,
  screenshotFilename,
  UnsafePathError,
} from "../../src/util/paths";

describe("convertPathForPlatform", () => {
  it("converts forward slashes to backslashes on win32", () => {
    expect(convertPathForPlatform("C:/Users/ted/shots", "win32")).toBe(
      "C:\\Users\\ted\\shots"
    );
  });

  it("converts a \\\\wsl.localhost\\Ubuntu path to a native linux path", () => {
    expect(
      convertPathForPlatform("\\\\wsl.localhost\\Ubuntu\\home\\ted\\shots", "linux")
    ).toBe("/home/ted/shots");
  });

  it("converts the legacy \\\\wsl$\\ form", () => {
    expect(
      convertPathForPlatform("\\\\wsl$\\Debian\\home\\ted\\shots", "linux")
    ).toBe("/home/ted/shots");
  });

  it("falls back to skipping the wsl prefix for unknown distributions", () => {
    expect(
      convertPathForPlatform("\\\\wsl.localhost\\MyCustomDistro\\home\\ted", "linux")
    ).toBe("/home/ted");
  });

  it("normalises non-WSL UNC paths", () => {
    expect(convertPathForPlatform("\\\\server\\share\\dir", "linux")).toBe(
      "/server/share/dir"
    );
  });

  it("converts windows drive paths on posix hosts", () => {
    expect(convertPathForPlatform("C:\\Users\\ted", "darwin")).toBe("/Users/ted");
  });

  it("leaves native posix paths untouched", () => {
    expect(convertPathForPlatform("/home/ted/shots", "linux")).toBe(
      "/home/ted/shots"
    );
    expect(convertPathForPlatform("/Users/ted/shots", "darwin")).toBe(
      "/Users/ted/shots"
    );
  });

  it("passes through empty input", () => {
    expect(convertPathForPlatform("", "linux")).toBe("");
  });
});

describe("resolveSafeScreenshotPath", () => {
  const base = path.join(os.tmpdir(), "bt-screens");

  it("resolves a plain filename inside the base directory", () => {
    const out = resolveSafeScreenshotPath(base, "shot.png");
    expect(out).toBe(path.join(base, "shot.png"));
  });

  it("allows a nested subdirectory inside the base directory", () => {
    const out = resolveSafeScreenshotPath(base, "session/shot.png");
    expect(out).toBe(path.join(base, "session", "shot.png"));
  });

  // These are the P0 regression tests: the old code took a caller-supplied
  // absolute path straight off the wire and wrote to it.
  it("rejects parent-directory traversal", () => {
    expect(() => resolveSafeScreenshotPath(base, "../evil.png")).toThrow(
      UnsafePathError
    );
    expect(() =>
      resolveSafeScreenshotPath(base, "a/../../evil.png")
    ).toThrow(UnsafePathError);
  });

  it("rejects absolute paths", () => {
    expect(() => resolveSafeScreenshotPath(base, "/etc/cron.d/evil")).toThrow(
      UnsafePathError
    );
  });

  it("rejects null bytes", () => {
    expect(() => resolveSafeScreenshotPath(base, "shot\u0000.png")).toThrow(
      UnsafePathError
    );
  });

  it("rejects shell metacharacters that could escape a command line", () => {
    // The old code interpolated this path into `osascript -e '...'`.
    for (const bad of ["shot'.png", 'shot".png', "shot`id`.png", "shot$(id).png"]) {
      expect(() => resolveSafeScreenshotPath(base, bad), bad).toThrow(
        UnsafePathError
      );
    }
  });

  it("rejects an empty filename", () => {
    expect(() => resolveSafeScreenshotPath(base, "")).toThrow(UnsafePathError);
  });
});

describe("screenshotFilename", () => {
  it("produces a shell-safe, sortable, unique png name", () => {
    const a = screenshotFilename(new Date("2026-07-30T12:34:56.789Z"));
    expect(a).toMatch(/^screenshot-[0-9TZ.-]+-[0-9a-f]{6}\.png$/);
    expect(a).not.toMatch(/[':"$`\\/\s]/);
  });

  it("does not collide across rapid successive calls", () => {
    const names = new Set(
      Array.from({ length: 200 }, () => screenshotFilename(new Date()))
    );
    expect(names.size).toBe(200);
  });
});
