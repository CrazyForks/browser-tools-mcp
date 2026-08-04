import net from "node:net";

/**
 * Waits until a TCP port is free.
 *
 * The end-to-end files each bind the connector's default port so the extension
 * can discover it, and a browser shutting down can hold its side open briefly
 * after the previous file finished. Without this, the next file's connector
 * silently lands on a different port while the extension still attaches to
 * whatever answers on the default one.
 */
export async function waitForPortFree(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isFree(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Port ${port} was still in use after ${timeoutMs}ms`);
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}
