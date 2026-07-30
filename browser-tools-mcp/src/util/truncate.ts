/** Payload shaping so captured telemetry fits an agent's context window. */

const TRUNCATION_SUFFIX = "... (truncated)";

/** Recursively caps the length of every string in a structure. */
export function truncateStringsInData(data: unknown, maxLength: number): unknown {
  return walk(data, maxLength, new WeakSet());
}

function walk(data: unknown, maxLength: number, seen: WeakSet<object>): unknown {
  if (typeof data === "string") {
    return data.length > maxLength
      ? data.substring(0, maxLength) + TRUNCATION_SUFFIX
      : data;
  }

  if (data === null || typeof data !== "object") return data;

  if (seen.has(data as object)) return "[Circular]";
  seen.add(data as object);

  if (Array.isArray(data)) {
    return data.map((item) => walk(item, maxLength, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    out[key] = walk(value, maxLength, seen);
  }
  return out;
}

/**
 * Chooses which log entries fit inside a character budget.
 *
 * Walks from the newest entry backwards, because when the budget forces a
 * choice the recent entries are the ones worth keeping. The result is returned
 * in chronological order. A single oversized entry is truncated rather than
 * allowed to hide everything around it.
 */
export function selectLogsWithinBudget<T>(logs: readonly T[], budget: number): T[] {
  if (logs.length === 0) return [];

  const selected: T[] = [];
  let used = 0;

  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i] as T;
    const size = safeSize(entry);

    if (used + size > budget) {
      // Always return something: if even the newest entry blows the budget,
      // hand back a truncated version of it rather than an empty result.
      if (selected.length === 0) {
        const perStringCap = Math.max(50, Math.floor(budget / 2));
        selected.push(truncateStringsInData(entry, perStringCap) as T);
      }
      break;
    }

    selected.push(entry);
    used += size;
  }

  return selected.reverse();
}

function safeSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}
