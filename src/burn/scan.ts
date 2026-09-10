import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AccountConfig } from '../types.ts';
import type { BurnResponse, BurnSession, BurnTotals } from './types.ts';
import { scanCodexBurn, type CodexBurnDeps } from './codex.ts';
import { cleanExtendedPath, cleanLocalPath, MAX_TAIL_BYTES, weigh, windowLines, type UsageRow } from './read.ts';

/**
 * Which local session burned an account's five-hour window.
 *
 * Two facts make this possible on this machine:
 *   1. every Claude home keeps its own `session-env/<sessionId>/` and `history.jsonl`, so a session
 *      id can be tied back to ONE account even though
 *   2. all homes share a single transcript store (`~/.claude/projects` is a junction in each home),
 *      which means the transcript itself never says which account paid for it.
 *
 * Token counts come from each assistant record's `message.usage`. The provider does not publish the
 * formula behind its own percentage, so sessions are ranked by a cost-shaped weight (below) and the
 * result is an estimate — good for "who ate it", never a substitute for `/api/usage`.
 */

export interface BurnDeps {
  base: string;
  accounts?: AccountConfig[];
  now?: () => number;
  windowHours?: number;
  cacheMs?: number;
  /** Codex-only: ssh targets and the injected scanner that reads them. See `burn/remote.ts`. */
  remotes?: string[];
  scanRemote?: CodexBurnDeps['scanRemote'];
}

interface HomeClaims {
  accountId: string;
  home: string;
  /** Session ids this home has ever run. */
  ids: Set<string>;
  /** Last prompt time per session id, from this home's own history.jsonl. */
  lastPromptMs: Map<string, number>;
}

/**
 * What one home knows about the sessions it ran. `session-env/` has a directory per session the home
 * started; `history.jsonl` adds the prompts, with times. Both live in the home itself — unlike
 * `projects/`, they are NOT shared between homes, which is what makes attribution possible at all.
 */
async function readHomeClaims(accountId: string, home: string): Promise<HomeClaims> {
  const ids = new Set<string>();
  const lastPromptMs = new Map<string, number>();
  try {
    for (const entry of await readdir(join(home, 'session-env'), { withFileTypes: true })) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  } catch { /* a home may never have written session-env */ }
  try {
    const text = await readFile(join(home, 'history.jsonl'), 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const id = /"sessionId"\s*:\s*"([^"]+)"/.exec(line)?.[1];
      if (!id) continue;
      ids.add(id);
      const at = Number(/"timestamp"\s*:\s*(\d+)/.exec(line)?.[1] ?? NaN);
      if (Number.isFinite(at) && at > (lastPromptMs.get(id) ?? -Infinity)) lastPromptMs.set(id, at);
    }
  } catch { /* optional */ }
  return { accountId, home, ids, lastPromptMs };
}

/**
 * Resume a session under another account and BOTH homes keep a claim on that id forever (about 10%
 * of ids on this machine). The window's payer is the home that used it last, so claims are resolved
 * by the freshest evidence: the last prompt in the home's history, else the session-env directory's
 * mtime. When a rival's evidence also falls inside the window the row is reported as contested
 * rather than silently assigned.
 */
async function evidenceMs(claim: HomeClaims, id: string): Promise<number> {
  const prompt = claim.lastPromptMs.get(id);
  if (prompt !== undefined) return prompt;
  try { return (await stat(join(claim.home, 'session-env', id))).mtimeMs; }
  catch { return -Infinity; }
}

/** The physical transcript store behind a home (junction-aware), else the shared default. */
async function transcriptsDir(home: string, base: string): Promise<string> {
  const local = join(home, 'projects');
  try { return cleanExtendedPath(await realpath(local)); }
  catch { return join(base, '.claude', 'projects'); }
}

function usageOf(message: { usage?: Record<string, unknown> }): UsageRow | null {
  const usage = message.usage;
  if (!usage) return null;
  const num = (key: string): number => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
  return {
    input: num('input_tokens'),
    cacheWrite: num('cache_creation_input_tokens'),
    cacheRead: num('cache_read_input_tokens'),
    output: num('output_tokens'),
  };
}

interface Accumulator extends UsageRow {
  replies: number;
  cwd: string | null;
  models: Map<string, number>;
  firstMs: number;
  lastMs: number;
}

export async function scanBurn(accountId: string, resetsAt: string | null, deps: BurnDeps): Promise<BurnResponse> {
  const now = (deps.now ?? Date.now)();
  const windowHours = deps.windowHours ?? 5;
  const accounts = deps.accounts ?? [];
  const warnings: string[] = [];
  const account = accounts.find((candidate) => candidate.id === accountId);
  const resetMs = resetsAt ? Date.parse(resetsAt) : NaN;
  // Anchor on the provider's own reset when we have it; a window with no known reset still answers
  // "the last five hours", which is what the operator is looking at.
  const windowStartMs = Number.isFinite(resetMs) ? resetMs - windowHours * 3_600_000 : now - windowHours * 3_600_000;
  const empty = (extra: string[]): BurnResponse => ({
    accountId,
    accountLabel: account?.label ?? accountId,
    windowStart: new Date(windowStartMs).toISOString(),
    resetsAt,
    windowHours,
    sessions: [],
    totals: { weight: 0, replies: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
    otherSessions: 0,
    generatedAt: new Date(now).toISOString(),
    partial: extra.length > 0,
    warnings: extra,
  });

  if (!account) return empty([`Unknown account ${accountId}`]);
  // Codex has its own scanner (per-home stores, a different rollout format); makeGetBurn routes
  // there. Grok keeps no local session store at all, so there is nothing to break down.
  if (account.provider !== 'claude') return empty(['Session breakdown covers Claude and Codex accounts only']);
  if (!account.credentialsHome) return empty(['This account has no configured home to attribute sessions from']);
  // Subtrack's own owned homes only ever contain usage probes, never interactive work sessions.
  if (account.credentialsMode !== 'readonly') return empty(['Only read-only (external CLI) homes carry local session history']);

  const home = account.credentialsHome;
  // Every read-only Claude home is read, not just this one: a session id can be claimed by several
  // homes, and the rival claims are what decide who actually paid for this window.
  const rivals = accounts.filter((other) => other.provider === 'claude' && other.credentialsMode === 'readonly' && other.credentialsHome);
  const claims = await Promise.all(rivals.map((other) => readHomeClaims(other.id, other.credentialsHome!)));
  const own = claims.find((claim) => claim.accountId === accountId) ?? await readHomeClaims(accountId, home);
  if (own.ids.size === 0) warnings.push(`No local session history found in ${home}`);
  const root = await transcriptsDir(home, deps.base);

  let files: { path: string; id: string; size: number }[] = [];
  try {
    for (const projectDir of await readdir(root, { withFileTypes: true })) {
      if (!projectDir.isDirectory()) continue;
      const dir = join(root, projectDir.name);
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const path = join(dir, entry.name);
        let info;
        try { info = await stat(path); } catch { continue; }
        // A transcript untouched since the window opened cannot hold a record inside it.
        if (info.mtimeMs < windowStartMs || info.size === 0) continue;
        files.push({ path, id: basename(entry.name, '.jsonl'), size: info.size });
      }
    }
  } catch (error) {
    return empty([`Transcript store ${root} could not be read: ${(error as Error).message}`]);
  }

  const mine: { path: string; id: string; size: number }[] = [];
  const contested = new Set<string>();
  let otherSessions = 0;
  for (const file of files) {
    if (!own.ids.has(file.id)) { otherSessions += 1; continue; }
    const others = claims.filter((claim) => claim.accountId !== accountId && claim.ids.has(file.id));
    if (others.length === 0) { mine.push(file); continue; }
    const ourEvidence = await evidenceMs(own, file.id);
    let bestRival = -Infinity;
    for (const rival of others) bestRival = Math.max(bestRival, await evidenceMs(rival, file.id));
    if (bestRival > ourEvidence) { otherSessions += 1; continue; }
    if (bestRival >= windowStartMs) contested.add(file.id);
    mine.push(file);
  }

  const rows = new Map<string, Accumulator>();
  for (const file of mine) {
    let read;
    try { read = await windowLines(file.path, file.size, windowStartMs); }
    catch (error) { warnings.push(`${file.id}: ${(error as Error).message}`); continue; }
    if (read.truncated) warnings.push(`${file.id}: only the last ${MAX_TAIL_BYTES / (1024 * 1024)} MiB were read`);
    for (const line of read.lines) {
      if (!line.includes('"usage"')) continue;
      let record: { type?: string; timestamp?: string; cwd?: string; sessionId?: string; message?: { model?: string; usage?: Record<string, unknown> } };
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== 'assistant' || !record.timestamp || !record.message) continue;
      const at = Date.parse(record.timestamp);
      if (!Number.isFinite(at) || at < windowStartMs || at > now) continue;
      const usage = usageOf(record.message);
      if (!usage) continue;
      const key = record.sessionId ?? file.id;
      const row = rows.get(key) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, replies: 0, cwd: null, models: new Map<string, number>(), firstMs: at, lastMs: at };
      row.input += usage.input;
      row.cacheWrite += usage.cacheWrite;
      row.cacheRead += usage.cacheRead;
      row.output += usage.output;
      row.replies += 1;
      row.firstMs = Math.min(row.firstMs, at);
      row.lastMs = Math.max(row.lastMs, at);
      if (record.cwd) row.cwd = cleanLocalPath(record.cwd);
      const model = record.message.model;
      if (model && model !== '<synthetic>') row.models.set(model, (row.models.get(model) ?? 0) + 1);
      rows.set(key, row);
    }
  }

  const totals: BurnTotals = { weight: 0, replies: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  for (const row of rows.values()) {
    totals.weight += weigh(row);
    totals.replies += row.replies;
    totals.inputTokens += row.input;
    totals.cacheWriteTokens += row.cacheWrite;
    totals.cacheReadTokens += row.cacheRead;
    totals.outputTokens += row.output;
  }

  const sessions: BurnSession[] = [...rows.entries()].map(([id, row]) => ({
    id,
    cwd: row.cwd,
    project: row.cwd ? basename(row.cwd) : null,
    share: totals.weight > 0 ? (weigh(row) / totals.weight) * 100 : 0,
    weight: Math.round(weigh(row)),
    replies: row.replies,
    inputTokens: row.input,
    cacheWriteTokens: row.cacheWrite,
    cacheReadTokens: row.cacheRead,
    outputTokens: row.output,
    models: [...row.models.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model),
    host: null,   // Claude sessions are always read from this machine
    firstAt: new Date(row.firstMs).toISOString(),
    lastAt: new Date(row.lastMs).toISOString(),
    contested: contested.has(id),
  })).sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));

  return {
    accountId,
    accountLabel: account.label ?? accountId,
    windowStart: new Date(windowStartMs).toISOString(),
    resetsAt,
    windowHours,
    sessions,
    totals,
    otherSessions,
    generatedAt: new Date(now).toISOString(),
    partial: warnings.length > 0,
    warnings,
  };
}

/** Both providers answer the same question from completely different local stores. */
function scanFor(accountId: string, resetsAt: string | null, deps: BurnDeps): Promise<BurnResponse> {
  const account = (deps.accounts ?? []).find((candidate) => candidate.id === accountId);
  return account?.provider === 'codex'
    ? scanCodexBurn(accountId, resetsAt, deps)
    : scanBurn(accountId, resetsAt, deps);
}

export function makeGetBurn(deps: BurnDeps): (accountId: string, resetsAt: string | null) => Promise<BurnResponse> {
  const cacheMs = deps.cacheMs ?? 30_000;
  const clock = deps.now ?? Date.now;
  const cached = new Map<string, { at: number; value: BurnResponse }>();
  const inflight = new Map<string, Promise<BurnResponse>>();
  return async (accountId, resetsAt) => {
    // The window start is part of the key: when the provider rolls the window, the old answer is
    // about a window that no longer exists and must not be served from cache.
    const key = `${accountId}|${resetsAt ?? 'rolling'}`;
    const now = clock();
    const hit = cached.get(key);
    if (hit && now - hit.at < cacheMs) return hit.value;
    const pending = inflight.get(key);
    if (pending) return pending;
    const run = scanFor(accountId, resetsAt, deps).then((value) => {
      cached.set(key, { at: clock(), value });
      inflight.delete(key);
      return value;
    }, (error) => {
      inflight.delete(key);
      throw error;
    });
    inflight.set(key, run);
    return run;
  };
}
