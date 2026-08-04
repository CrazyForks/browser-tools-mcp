import { describe, it, expect } from "vitest";
import {
  parseImageDataUrl,
  extensionForMimeType,
  withExtension,
  approximateBytes,
  SUPPORTED_IMAGE_MIME_TYPES,
} from "../../src/util/image";
import { screenshotFilename } from "../../src/util/paths";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("parseImageDataUrl", () => {
  it("reads a png data url", () => {
    const parsed = parseImageDataUrl(`data:image/png;base64,${PNG_1PX}`);
    expect(parsed).toEqual({ mimeType: "image/png", base64: PNG_1PX });
  });

  it("reads a jpeg data url", () => {
    const parsed = parseImageDataUrl("data:image/jpeg;base64,/9j/4AAQSkZJRg==");
    expect(parsed?.mimeType).toBe("image/jpeg");
    expect(parsed?.base64).toBe("/9j/4AAQSkZJRg==");
  });

  it("accepts a bare base64 payload and assumes png", () => {
    // The extension has always sent a data url, but a bare payload should not
    // silently produce a corrupt file.
    expect(parseImageDataUrl(PNG_1PX)).toEqual({ mimeType: "image/png", base64: PNG_1PX });
  });

  it("rejects an unsupported image type rather than guessing", () => {
    expect(parseImageDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeNull();
    expect(parseImageDataUrl("data:text/html;base64,PGgxPjwvaDE+")).toBeNull();
  });

  it("rejects empty or malformed input", () => {
    expect(parseImageDataUrl("")).toBeNull();
    expect(parseImageDataUrl("data:image/png;base64,")).toBeNull();
    expect(parseImageDataUrl(undefined as unknown as string)).toBeNull();
  });

  it("supports exactly the formats a browser can encode", () => {
    expect([...SUPPORTED_IMAGE_MIME_TYPES].sort()).toEqual(["image/jpeg", "image/png"]);
  });
});

describe("extensionForMimeType", () => {
  it("maps supported types to file extensions", () => {
    expect(extensionForMimeType("image/png")).toBe("png");
    expect(extensionForMimeType("image/jpeg")).toBe("jpg");
  });

  it("falls back to png for anything else", () => {
    expect(extensionForMimeType("image/webp")).toBe("png");
  });
});

describe("withExtension", () => {
  it("replaces a mismatched extension so the file is not mislabelled", () => {
    // A caller asking for "shot.png" that we had to encode as JPEG must not end
    // up with JPEG bytes in a .png file.
    expect(withExtension("shot.png", "jpg")).toBe("shot.jpg");
    expect(withExtension("shot.jpeg", "png")).toBe("shot.png");
  });

  it("leaves a matching extension alone", () => {
    expect(withExtension("shot.png", "png")).toBe("shot.png");
    expect(withExtension("shot.jpg", "jpg")).toBe("shot.jpg");
  });

  it("adds an extension when there is none", () => {
    expect(withExtension("shot", "png")).toBe("shot.png");
  });

  it("keeps directories and dotted names intact", () => {
    expect(withExtension("run-1/my.shot.v2.png", "jpg")).toBe("run-1/my.shot.v2.jpg");
    expect(withExtension("nested/dir/shot", "jpg")).toBe("nested/dir/shot.jpg");
  });
});

describe("approximateBytes", () => {
  it("estimates decoded size from base64 length", () => {
    // 4 base64 chars encode 3 bytes.
    expect(approximateBytes("A".repeat(4))).toBe(3);
    expect(approximateBytes("A".repeat(400))).toBe(300);
  });

  it("accounts for padding", () => {
    expect(approximateBytes("AAA=")).toBe(2);
    expect(approximateBytes("AA==")).toBe(1);
  });

  it("handles an empty payload", () => {
    expect(approximateBytes("")).toBe(0);
  });
});

describe("screenshotFilename with a format", () => {
  it("defaults to png", () => {
    expect(screenshotFilename(new Date("2026-08-03T10:00:00.000Z"))).toMatch(/\.png$/);
  });

  it("honours a requested extension", () => {
    expect(screenshotFilename(new Date("2026-08-03T10:00:00.000Z"), "jpg")).toMatch(/\.jpg$/);
  });

  it("stays shell-safe whatever the extension", () => {
    const name = screenshotFilename(new Date(), "jpg");
    expect(name).not.toMatch(/[':"$`\\/\s]/);
  });
});
