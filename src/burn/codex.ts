import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AccountConfig } from '../types.ts';
import type { BurnResponse, BurnSession, BurnTotals } from './types.ts';
import { cleanExtendedPath, cleanLocalPath, MAX_TAIL_BYTES, pathKey, readChunk, weigh, windowLines } from './read.ts';
import type { RemoteBurnScan } from './remote.ts';

/**
 * Which local session burned a Codex account's five-hour window.
 *
 * Codex is NOT Claude, and the difference decides the whole design:
 *
 *   1. A Codex session store is per-home (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`), so a
 *      file already belongs to exactly one home — none of Claude's shared-store claim resolution is
 *      needed. When two homes DO share one physical store (the cx launcher homes junction theirs to
 *      `.codex-fleet/sessions`) nothing local can split it, so such a store is skipped, not guessed.
 *   2. The home a card is configured with is often not the home the work runs in: on this machine
 *      the `codex-1` card points at an auth mirror while its sessions live in `~/.codex`, and the
 *      `codex-3`/`codex-5` cards point at launcher homes whose store is a dead junction. The only
 *      thing that reliably ties a store to a subscription is the ChatGPT account id in the home's
 *      `auth.json`, so homes are discovered and matched by that id rather than by configured path.
 *
 * Token counts come from the rollout itself and are a LOCAL ESTIMATE, exactly like the Claude side:
 * the provider publishes one percentage per window and never names a session.
 */

/** Roots that can hold a Codex home on this machine, relative to the user's home directory. */
const HOME_ROOTS: string[][] = [
  ['.codex'],                        // the main CLI/desktop home, itself a home
  ['.codex-homes'],                  // per-account homes of the desktop app and the cx lanes
  ['.subtrack', 'codex-homes'],      // homes subtrack owns or mirrors
];
/** `session_meta` is the first record of a rollout; it is large (base instructions) but bounded. */
const HEAD_BYTES = 256 * 1024;

interface CodexUsage { input: number; cacheWrite: number; cacheRead: number; output: number }

interface Accumulator extends CodexUsage {
  replies: number;
  cwd: string | null;
  models: Map<string, number>;
  firstMs: number;
  lastMs: number;
  /** null = this machine; otherwise the ssh target the row was read from. */
  host: string | null;
}

/**
 * The ChatGPT account id a Codex home is signed into. Shapes follow `readCodexAuth`, minus its
 * demand for a live access token: a home with a stale login still identifies its owner, and that is
 * all this scan needs.
 */
async function homeAccountId(home: string): Promise<string | null> {
  let parsed: {
    tokens?: { account_id?: string };
    account_id?: string;
    providers?: { 'openai-codex'?: { tokens?: { account_id?: string }; account_id?: string } };
  };
  try { parsed = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')); }
  catch { return null; }
  const shared = parsed.providers?.['openai-codex'];
  const id = parsed.tokens?.account_id ?? shared?.tokens?.account_id ?? shared?.account_id ?? parsed.account_id;
  return typeof id === 'string' && id ? id : null;
}

/** Every directory that could be a Codex home, without deciding yet whose it is. */
async function candidateHomes(base: string, accounts: AccountConfig[]): Promise<string[]> {
  const found = new Map<string, string>();
  const add = (path: string): void => { found.set(pathKey(path), path); };
  for (const parts of HOME_ROOTS) {
    const root = join(base, ...parts);
    // A root is either a home itself (~/.codex) or a folder of homes (~/.codex-homes).
    try { await stat(join(root, 'auth.json')); add(root); } catch { /* not a home itself */ }
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) add(join(root, entry.name));
      }
    } catch { /* root may not exist on this machine */ }
  }
  // A configured home may live outside the conventional roots (the Hermes shared stores do).
  for (const account of accounts) {
    if (account.provider === 'codex' && account.credentialsHome) add(account.credentialsHome);
  }
  return [...found.values()];
}

/** The physical session directory behind a home, resolving the junctions the cx lanes use. */
async function storeOf(home: string): Promise<string | null> {
  const local = join(home, 'sessions');
  try { return cleanExtendedPath(await realpath(local)); }
  catch { return null; }
}

/** `YYYY/MM/DD` folder names that a window can touch, in local time (Codex names them locally). */
function windowDayKeys(windowStartMs: number, nowMs: number): Set<string> {
  const keys = new Set<string>();
  const day = 86_400_000;
  // One day of slack each way: a session started before midnight keeps appending after it.
  for (let at = windowStartMs - day; at <= nowMs + day; at += day) {
    const d = new Date(at);
    keys.add(`${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`);
  }
  const end = new Date(nowMs + day);
  keys.add(`${end.getFullYear()}/${String(end.getMonth() + 1).padStart(2, '0')}/${String(end.getDate()).padStart(2, '0')}`);
  return keys;
}

/**
 * Rollout files a window can contain. Codex files itself by date, so only a handful of folders are
 * ever opened — which is what keeps this cheap next to a store holding tens of thousands of files.
 */
async function windowFiles(store: string, windowStartMs: number, nowMs: number): Promise<{ path: string; size: number }[]> {
  const days = windowDayKeys(windowStartMs, nowMs);
  const files: { path: string; size: number }[] = [];
  let years: string[] = [];
  try { years = (await readdir(store, { withFileTypes: true })).filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name)).map((e) => e.name); }
  catch { return files; }
  for (const year of years) {
    let months: string[] = [];
    try { months = (await readdir(join(store, year), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { continue; }
    for (const month of months) {
      let dayNames: string[] = [];
      try { dayNames = (await readdir(join(store, year, month), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
      catch { continue; }
      for (const day of dayNames) {
        if (!days.has(`${year}/${month}/${day}`)) continue;
        const dir = join(store, year, month, day);
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const path = join(dir, entry.name);
          let info;
          try { info = await stat(path); } catch { continue; }
          // A rollout untouched since the window opened cannot hold a record inside it.
          if (info.mtimeMs < windowStartMs || info.size === 0) continue;
          files.push({ path, size: info.size });
        }
      }
    }
  }
  return files;
}

/**
 * What a rollout says about itself: the session it belongs to and where it ran. A subagent thread
 * gets its own file but keeps the parent's `session_id`, which is what rolls it into one row.
 */
async function readHead(path: string, size: number): Promise<{ sessionId: string | null; cwd: string | null; model: string | null }> {
  let head = '';
  try { head = await readChunk(path, 0, Math.min(size, HEAD_BYTES)); } catch { return { sessionId: null, cwd: null, model: null }; }
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  for (const line of head.split('\n')) {
    if (!line) continue;
    let record: { type?: string; payload?: Record<string, unknown> };
    try { record = JSON.parse(line); } catch { continue; }   // a truncated last line is expected
    const payload = record.payload ?? {};
    if (record.type === 'session_meta') {
      const id = payload['session_id'] ?? payload['id'];
      if (typeof id === 'string') sessionId = id;
      if (typeof payload['cwd'] === 'string') cwd = cleanLocalPath(payload['cwd']);
    }
    if (record.type === 'turn_context' && !model && typeof payload['model'] === 'string') model = payload['model'];
    if (sessionId && cwd && model) break;
  }
  return { sessionId, cwd, model };
}

function usageFrom(raw: unknown): CodexUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const num = (key: string): number => (typeof u[key] === 'number' ? (u[key] as number) : 0);
  const total = num('input_tokens');
  const cached = num('cached_input_tokens');
  return {
    // Codex reports one `input_tokens` that already contains the cached part; split it so the two
    // providers hand the UI the same four numbers.
    input: Math.max(0, total - cached),
    cacheWrite: num('cache_write_input_tokens'),
    cacheRead: cached,
    output: num('output_tokens'),
  };
}

export interface CodexBurnDeps {
  base: string;
  accounts?: AccountConfig[];
  now?: () => number;
  windowHours?: number;
  /** ssh targets that also run Codex under these logins (the Mac and Hetzner lanes). */
  remotes?: string[];
  /** Injected so tests never shell out; absent means "this machine only". */
  scanRemote?: (host: string, windowStartMs: number, nowMs: number) => Promise<RemoteBurnScan>;
}

export async function scanCodexBurn(accountId: string, resetsAt: string | null, deps: CodexBurnDeps): Promise<BurnResponse> {
  const now = (deps.now ?? Date.now)();
  const windowHours = deps.windowHours ?? 5;
  const accounts = deps.accounts ?? [];
  const account = accounts.find((candidate) => candidate.id === accountId);
  const resetMs = resetsAt ? Date.parse(resetsAt) : NaN;
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

  const warnings: string[] = [];
  // Identity first: the configured home names the subscription even when the work runs elsewhere.
  const identity = new Set<string>();
  for (const home of [account.credentialsHome, join(deps.base, '.subtrack', 'codex-homes', accountId)]) {
    if (!home) continue;
    const id = await homeAccountId(home);
    if (id) identity.add(id);
  }
  if (identity.size === 0) return empty([`No readable Codex login found for ${accountId} — cannot tell which local sessions belong to it`]);

  // One physical store can be reached from several homes (the cx lanes junction theirs together).
  // Collect owners per store so a store shared by two subscriptions is skipped instead of guessed.
  const owners = new Map<string, { store: string; accountIds: Set<string> }>();
  for (const home of await candidateHomes(deps.base, accounts)) {
    const id = await homeAccountId(home);
    if (!id) continue;
    const store = await storeOf(home);
    if (!store) continue;
    const key = pathKey(store);
    const entry = owners.get(key) ?? { store, accountIds: new Set<string>() };
    entry.accountIds.add(id);
    owners.set(key, entry);
  }

  const mine: string[] = [];
  const theirs: string[] = [];
  for (const entry of owners.values()) {
    const isOurs = [...entry.accountIds].some((id) => identity.has(id));
    if (entry.accountIds.size > 1) {
      // Only worth saying when the shared store actually holds work inside this window: the cx
      // lanes' junctioned store has been idle for weeks, and warning about it on every refresh
      // would mark every Codex card `partial` for nothing.
      if (isOurs && (await windowFiles(entry.store, windowStartMs, now)).length > 0) {
        warnings.push(`${entry.store} is shared by ${entry.accountIds.size} logins — sessions there cannot be attributed`);
      }
      continue;
    }
    if (isOurs) mine.push(entry.store); else theirs.push(entry.store);
  }
  const rows = new Map<string, Accumulator>();
  for (const store of mine) {
    for (const file of await windowFiles(store, windowStartMs, now)) {
      const name = basename(file.path, '.jsonl');
      let read;
      try { read = await windowLines(file.path, file.size, windowStartMs); }
      catch (error) { warnings.push(`${name}: ${(error as Error).message}`); continue; }
      if (read.truncated) warnings.push(`${name}: only the last ${MAX_TAIL_BYTES / (1024 * 1024)} MiB were read`);
      const head = await readHead(file.path, file.size);

      // Two rollout formats live side by side on this machine. CLI 0.153 writes one
      // `token_usage_record` per response AND repeats `token_count` events, which double-count when
      // summed; CLI 0.147 writes only `token_count`, whose `last_token_usage` sums exactly to the
      // session total (both verified against the sessions' own running totals). So: prefer the
      // records, and fall back per file, never mixing the two sources.
      const records: { at: number; usage: CodexUsage; responseId: string | null }[] = [];
      const counts: { at: number; usage: CodexUsage }[] = [];
      const models = new Map<string, number>();
      let cwd = head.cwd;
      for (const line of read.lines) {
        let record: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
        try { record = JSON.parse(line); } catch { continue; }
        const payload = record.payload ?? {};
        if (record.type === 'turn_context') {
          const model = payload['model'];
          if (typeof model === 'string') models.set(model, (models.get(model) ?? 0) + 1);
          if (!cwd && typeof payload['cwd'] === 'string') cwd = cleanLocalPath(payload['cwd']);
          continue;
        }
        const at = record.timestamp ? Date.parse(record.timestamp) : NaN;
        if (!Number.isFinite(at) || at < windowStartMs || at > now) continue;
        if (record.type === 'token_usage_record') {
          const usage = usageFrom(payload['usage']);
          const responseId = typeof payload['response_id'] === 'string' ? payload['response_id'] : null;
          if (usage) records.push({ at, usage, responseId });
        } else if (record.type === 'event_msg' && payload['type'] === 'token_count') {
          const info = payload['info'] as Record<string, unknown> | undefined;
          const usage = usageFrom(info?.['last_token_usage']);
          if (usage) counts.push({ at, usage });
        }
      }

      const key = head.sessionId ?? name;
      const row = rows.get(key) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, replies: 0, cwd: null, models: new Map<string, number>(), firstMs: Infinity, lastMs: -Infinity, host: null };
      const seen = new Set<string>();
      const chosen = records.length > 0
        ? records.filter((entry) => {
            // One response can be recorded twice when a turn is retried; the id makes it one turn.
            if (!entry.responseId) return true;
            if (seen.has(entry.responseId)) return false;
            seen.add(entry.responseId);
            return true;
          })
        : counts;
      for (const entry of chosen) {
        row.input += entry.usage.input;
        row.cacheWrite += entry.usage.cacheWrite;
        row.cacheRead += entry.usage.cacheRead;
        row.output += entry.usage.output;
        row.replies += 1;
        row.firstMs = Math.min(row.firstMs, entry.at);
        row.lastMs = Math.max(row.lastMs, entry.at);
      }
      if (chosen.length === 0) continue;   // the file was touched in the window but spent nothing
      if (cwd && !row.cwd) row.cwd = cwd;
      const fileModels = models.size > 0 ? models : new Map(head.model ? [[head.model, 1]] : []);
      for (const [model, count] of fileModels) row.models.set(model, (row.models.get(model) ?? 0) + count);
      rows.set(key, row);
    }
  }

  let otherSessions = 0;
  for (const store of theirs) otherSessions += (await windowFiles(store, windowStartMs, now)).length;

  // The same window, on the machines where Codex actually runs. One trip per host answers for every
  // card, so rows come back for all logins and are filtered to this one here.
  const remotes = deps.remotes ?? [];
  let remoteReached = 0;
  if (deps.scanRemote) {
    for (const host of remotes) {
      let scan: RemoteBurnScan;
      try { scan = await deps.scanRemote(host, windowStartMs, now); }
      catch (error) { warnings.push(`${host}: ${(error as Error).message}`); continue; }
      remoteReached += 1;
      for (const note of scan.warnings) warnings.push(`${host}: ${note}`);
      for (const store of scan.shared) warnings.push(`${host}:${store} is shared by several logins — sessions there cannot be attributed`);
      for (const remoteRow of scan.rows) {
        if (!identity.has(remoteRow.accountId)) { otherSessions += 1; continue; }
        const key = remoteRow.sessionId;
        const row = rows.get(key) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, replies: 0, cwd: null, models: new Map<string, number>(), firstMs: Infinity, lastMs: -Infinity, host };
        row.input += remoteRow.input;
        row.cacheWrite += remoteRow.cacheWrite;
        row.cacheRead += remoteRow.cacheRead;
        row.output += remoteRow.output;
        row.replies += remoteRow.replies;
        row.firstMs = Math.min(row.firstMs, remoteRow.firstMs);
        row.lastMs = Math.max(row.lastMs, remoteRow.lastMs);
        if (!row.cwd && remoteRow.cwd) row.cwd = cleanLocalPath(remoteRow.cwd);
        for (const [model, count] of Object.entries(remoteRow.models)) row.models.set(model, (row.models.get(model) ?? 0) + count);
        rows.set(key, row);
      }
    }
  }

  if (mine.length === 0 && remoteReached === 0) {
    return empty([...warnings, remotes.length > 0
      ? 'No Codex session store belongs to this login here, and no configured machine answered'
      : 'No Codex session store on this machine belongs to this login']);
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
    host: row.host,
    firstAt: new Date(row.firstMs).toISOString(),
    lastAt: new Date(row.lastMs).toISOString(),
    // Codex stores are per-home, so a session has exactly one owner; a store two logins share is
    // dropped above instead of being reported as a contested row.
    contested: false,
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
