/**
 * Low-level reading shared by the Claude and Codex burn scanners.
 *
 * Both providers append their session records in time order to one large JSONL file per session, so
 * both want the same two things: read only the tail that can still contain the window, and weigh a
 * usage row the same way so one UI can rank sessions from either provider.
 */

import { open } from 'node:fs/promises';
import { normalize, parse } from 'node:path';

/** Cost-shaped weights: output is the expensive token, cache reads are the cheap one. */
export const WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } as const;

/** Never read more than this from one transcript tail; a longer window degrades to `partial`. */
export const MAX_TAIL_BYTES = 64 * 1024 * 1024;

export interface UsageRow {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export function weigh(row: UsageRow): number {
  return row.input * WEIGHTS.input + row.cacheWrite * WEIGHTS.cacheWrite + row.cacheRead * WEIGHTS.cacheRead + row.output * WEIGHTS.output;
}

export function pathKey(path: string): string {
  return normalize(path).replace(/[\\/]+$/, '').toLowerCase();
}

export function cleanExtendedPath(path: string): string {
  return path.startsWith('\\\\?\\') ? path.slice(4) : path;
}

export function cleanLocalPath(path: string): string {
  const cleaned = normalize(cleanExtendedPath(path));
  const root = parse(cleaned).root;
  return cleaned.length > root.length ? cleaned.replace(/[\\/]+$/, '') : cleaned;
}

export async function readChunk(path: string, start: number, length: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

/**
 * Read only the tail that can contain the window. Records are appended in time order, so growing the
 * tail until its first timestamp predates the window start is enough — and far cheaper than parsing
 * a multi-hundred-megabyte transcript on every refresh.
 */
export async function windowLines(path: string, size: number, windowStartMs: number): Promise<{ lines: string[]; truncated: boolean }> {
  let take = Math.min(size, 1024 * 1024);
  while (true) {
    const start = size - take;
    const text = await readChunk(path, start, take);
    const lines = text.split('\n');
    if (start > 0) lines.shift(); // the first line is cut mid-record
    let earliest = Infinity;
    for (const line of lines) {
      const match = /"timestamp"\s*:\s*"([^"]+)"/.exec(line);
      if (!match) continue;
      const parsed = Date.parse(match[1]!);
      if (Number.isFinite(parsed) && parsed < earliest) earliest = parsed;
    }
    if (start === 0 || earliest < windowStartMs) return { lines, truncated: false };
    if (take >= MAX_TAIL_BYTES || take >= size) return { lines, truncated: take < size };
    take = Math.min(size, take * 4);
  }
}
