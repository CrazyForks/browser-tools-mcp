/**
 * Logging for a process that speaks JSON-RPC on stdout.
 *
 * Every message goes to stderr. Nothing in this project may ever call
 * console.log: a single stray line on stdout corrupts the MCP framing and the
 * client drops the session, which was the single most reported bug in 1.2.x.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function resolveLevel(): LogLevel {
  const raw = (process.env["BROWSER_TOOLS_LOG_LEVEL"] ?? "").toLowerCase();
  if (raw in LEVEL_ORDER) return raw as LogLevel;
  return "info";
}

let currentLevel: LogLevel = resolveLevel();

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function write(level: LogLevel, scope: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  const parts = args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack ?? arg.message;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  });

  const prefix = scope ? `[${scope}] ` : "";
  process.stderr.write(`${level.toUpperCase()} ${prefix}${parts.join(" ")}\n`);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(scope = ""): Logger {
  return {
    debug: (...args) => write("debug", scope, args),
    info: (...args) => write("info", scope, args),
    warn: (...args) => write("warn", scope, args),
    error: (...args) => write("error", scope, args),
    child: (child) => createLogger(scope ? `${scope}:${child}` : child),
  };
}

export const logger = createLogger();
