import { readdir, readFile, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, normalize, parse } from 'node:path';
import type { AccountConfig } from '../types.ts';
import { runPwsh, type PwshRunner } from '../ops/windows.ts';
import { gatherLiveClaudeWindows } from './windows.ts';
import type { LiveSessionWindow, RawLiveClaudeWindow, SessionsResponse, WorkSession } from './types.ts';

interface Store {
  provider: 'claude' | 'codex';
  home: string;
  homeKey: string;
  accountId: string;
  accountLabel: string;
  launcher: string;
}

interface Candidate extends Store {
  id: string;
  title: string | null;
  cwd: string;
  branch: string | null;
  activityMs: number;
  size: number;
  archived: boolean;
}

interface ClaudeMetadata {
  cwd: string;
  title: string | null;
  branch: string | null;
  activityMs: number;
}

interface MetadataCacheEntry {
  mtimeMs: number;
  size: number;
  value: ClaudeMetadata | null;
}

interface ScanState {
  claudeMetadata: Map<string, MetadataCacheEntry>;
  projectInfo: Map<string, { project: string; folder: string }>;
}

export interface SessionsDeps {
  base: string;
  accounts?: AccountConfig[];
  run?: PwshRunner;
  getLiveWindows?: () => Promise<RawLiveClaudeWindow[]>;
  now?: () => number;
  recentHours?: number;
  cacheMs?: number;
}

function pathKey(path: string): string {
  return normalize(path).replace(/[\\/]+$/, '').toLowerCase();
}

function cleanExtendedPath(path: string): string {
  return path.startsWith('\\\\?\\') ? path.slice(4) : path;
}

function cleanLocalPath(path: string): string {
  const cleaned = normalize(cleanExtendedPath(path));
  const root = parse(cleaned).root;
  return cleaned.length > root.length ? cleaned.replace(/[\\/]+$/, '') : cleaned;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildResumeCommand(provider: 'claude' | 'codex', launcher: string, home: string, cwd: string, id: string): string {
  if (provider === 'claude') {
    if (launcher !== 'claude') return `Set-Location -LiteralPath ${psQuote(cwd)}; ${launcher} --resume ${psQuote(id)}`;
    return `$env:CLAUDE_CONFIG_DIR=${psQuote(home)}; Set-Location -LiteralPath ${psQuote(cwd)}; claude --resume ${psQuote(id)}`;
  }
  return `$env:CODEX_HOME=${psQuote(home)}; codex resume -C ${psQuote(cwd)} ${psQuote(id)}`;
}

function decodeJsonString(value: string): string | null {
  try { return JSON.parse(`"${value}"`) as string; } catch { return null; }
}

function jsonStrings(text: string, key: string): string[] {
  const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`"${safeKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'g');
  const out: string[] = [];
  for (const match of text.matchAll(re)) {
    const decoded = decodeJsonString(match[1] ?? '');
    if (decoded !== null) out.push(decoded);
  }
  return out;
}

function last<T>(values: T[]): T | undefined {
  return values.length ? values[values.length - 1] : undefined;
}

function cleanTitle(value: string | undefined): string | null {
  if (!value) return null;
  const title = value.replace(/\s+/g, ' ').trim();
  if (!title) return null;
  return title.length > 180 ? `${title.slice(0, 177)}…` : title;
}

async function readChunk(path: string, start: number, length: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

async function readClaudeMetadata(path: string, info: { mtimeMs: number; size: number }, cache: Map<string, MetadataCacheEntry>): Promise<ClaudeMetadata | null> {
  const key = pathKey(path);
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value;

  const head = await readChunk(path, 0, Math.min(info.size, 192 * 1024));
  const tailStart = Math.max(0, info.size - 96 * 1024);
  const tail = tailStart === 0 ? head : await readChunk(path, tailStart, info.size - tailStart);
  const cwd = last(jsonStrings(head, 'cwd')) ?? last(jsonStrings(tail, 'cwd'));
  if (!cwd) {
    cache.set(key, { ...info, value: null });
    return null;
  }

  const customTitle = last(jsonStrings(head, 'customTitle'));
  const aiTitle = last(jsonStrings(head, 'aiTitle'));
  const agentName = last(jsonStrings(head, 'agentName'));
  const branch = last(jsonStrings(tail, 'gitBranch')) ?? last(jsonStrings(head, 'gitBranch')) ?? null;
  const timestamps = [...jsonStrings(head, 'timestamp'), ...jsonStrings(tail, 'timestamp')]
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  // Copying a transcript or adding metadata changes mtime without user activity. Transcript
  // timestamps are authoritative; filesystem time is only a fallback for older/stub formats.
  const activityMs = timestamps.length ? Math.max(...timestamps) : info.mtimeMs;
  const value: ClaudeMetadata = {
    cwd: cleanLocalPath(cwd),
    title: cleanTitle(customTitle ?? aiTitle ?? agentName),
    branch,
    activityMs,
  };
  cache.set(key, { ...info, value });
  return value;
}

function accountForClaudeHome(home: string, base: string, accounts: AccountConfig[]): Store {
  const configured = accounts.find((account) => account.provider === 'claude' && account.credentialsHome && pathKey(account.credentialsHome) === pathKey(home));
  const leaf = basename(home);
  const numbered = /^(\d+)-/.exec(leaf);
  const id = configured?.id ?? (numbered ? `claude-${numbered[1]}` : leaf === '.claude' ? 'claude-default' : `claude-${leaf}`);
  const launcher = numbered ? `cc${numbered[1]}` : /^claude-(\d+)$/.test(id) ? `cc${id.slice(7)}` : leaf === '.claude' ? 'ccdefault' : 'claude';
  return {
    provider: 'claude', home, homeKey: pathKey(home), accountId: id,
    accountLabel: configured?.label ?? (numbered ? `${launcher} · ${leaf.replace(/^\d+-/, '')}` : leaf === '.claude' ? 'Claude default' : leaf),
    launcher,
  };
}

function accountForCodexHome(home: string, base: string, accounts: AccountConfig[]): Store {
  const configured = accounts.find((account) => account.provider === 'codex' && account.credentialsHome && pathKey(account.credentialsHome) === pathKey(home));
  const isDefault = pathKey(home) === pathKey(join(base, '.codex'));
  return {
    provider: 'codex', home, homeKey: pathKey(home),
    accountId: configured?.id ?? (isDefault ? 'codex-default' : basename(home)),
    accountLabel: configured?.label ?? (isDefault ? 'Codex Desktop' : basename(home)),
    launcher: 'codex',
  };
}

async function discoverClaudeStores(base: string, accounts: AccountConfig[]): Promise<Store[]> {
  const homes = new Map<string, string>();
  const add = (home: string) => homes.set(pathKey(home), home);
  add(join(base, '.claude'));
  const accountRoot = join(base, '.claude-accounts');
  try {
    for (const entry of await readdir(accountRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !/(backup|\.bak$|\.old$)/i.test(entry.name)) add(join(accountRoot, entry.name));
    }
  } catch { /* optional root */ }
  // Owned usage homes have a single refresh owner (subtrack) and can contain probe transcripts.
  // They are not interactive work-session homes and must never become resume targets. A configured
  // read-only home, by contrast, belongs to an external Claude CLI and is safe to inventory here.
  for (const account of accounts) {
    if (account.provider === 'claude' && account.credentialsMode === 'readonly' && account.credentialsHome) add(account.credentialsHome);
  }

  // Several homes' projects/ can be junctions to one physical store (the cc-account homes
  // share ~/.claude/projects since 2026-07-17). Scanning each alias would read the same
  // transcripts N times and attribute the deduplicated session to an arbitrary alias, so keep
  // exactly one store per physical projects directory, preferring the home that owns it.
  const byTarget = new Map<string, { home: string; physical: boolean }>();
  for (const home of homes.values()) {
    const projects = join(home, 'projects');
    if (!(await exists(projects))) continue;
    let target = pathKey(projects);
    let physical = true;
    try {
      const real = pathKey(cleanExtendedPath(await realpath(projects)));
      physical = real === target;
      target = real;
    } catch { /* unresolvable link: fall back to the lexical path */ }
    const seen = byTarget.get(target);
    if (!seen || (physical && !seen.physical)) byTarget.set(target, { home, physical });
  }
  return [...byTarget.values()].map(({ home }) => accountForClaudeHome(home, base, accounts));
}

async function discoverCodexStores(base: string, accounts: AccountConfig[]): Promise<Store[]> {
  const homes = new Map<string, string>();
  const add = (home: string) => homes.set(pathKey(home), home);
  add(join(base, '.codex'));
  for (const account of accounts) if (account.provider === 'codex' && account.credentialsHome) add(account.credentialsHome);
  const out: Store[] = [];
  for (const home of homes.values()) if (await exists(join(home, 'state_5.sqlite'))) out.push(accountForCodexHome(home, base, accounts));
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function scanClaudeStore(store: Store, cache: Map<string, MetadataCacheEntry>): Promise<Candidate[]> {
  const files: string[] = [];
  for (const projectDir of await readdir(join(store.home, 'projects'), { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const dir = join(store.home, 'projects', projectDir.name);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(dir, entry.name));
    }
  }
  const rows = await mapLimit(files, 24, async (path): Promise<Candidate | null> => {
    const info = await stat(path);
    const metadata = await readClaudeMetadata(path, { mtimeMs: info.mtimeMs, size: info.size }, cache);
    if (!metadata) return null; // metadata-only stubs have no cwd and are not resumable work sessions
    return {
      ...store,
      id: basename(path, '.jsonl'),
      title: metadata.title,
      cwd: metadata.cwd,
      branch: metadata.branch,
      activityMs: metadata.activityMs,
      size: info.size,
      archived: false,
    };
  });
  return rows.filter((row): row is Candidate => row !== null);
}

function threadNames(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (typeof row.id === 'string' && typeof row.thread_name === 'string') names.set(row.id, row.thread_name);
    } catch { /* tolerate a partially-written last line */ }
  }
  return names;
}

interface CodexThreadRow {
  id: string;
  cwd: string;
  title: string | null;
  updated_at: number | null;
  updated_at_ms: number | null;
  archived: number;
  git_branch: string | null;
}

async function scanCodexStore(store: Store): Promise<Candidate[]> {
  const indexPath = join(store.home, 'session_index.jsonl');
  let names = new Map<string, string>();
  try { names = threadNames(await readFile(indexPath, 'utf8')); } catch { /* optional */ }

  const sqlite = await import('node:sqlite');
  const db = new sqlite.DatabaseSync(join(store.home, 'state_5.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT id, cwd, title, updated_at, updated_at_ms, archived, git_branch
      FROM threads
      WHERE source IN ('vscode', 'cli')
    `).all() as unknown as CodexThreadRow[];
    return rows.flatMap((row): Candidate[] => {
      if (typeof row.id !== 'string' || typeof row.cwd !== 'string' || !row.cwd) return [];
      const activityMs = Number(row.updated_at_ms) > 0 ? Number(row.updated_at_ms) : Number(row.updated_at) * 1000;
      return [{
        ...store,
        id: row.id,
        title: cleanTitle(names.get(row.id) ?? row.title ?? undefined),
        cwd: cleanLocalPath(row.cwd),
        branch: typeof row.git_branch === 'string' && row.git_branch ? row.git_branch : null,
        activityMs: Number.isFinite(activityMs) && activityMs > 0 ? activityMs : 0,
        size: 0,
        archived: Boolean(row.archived),
      }];
    });
  } finally { db.close(); }
}

async function getProjectInfo(cwd: string, cache: Map<string, { project: string; folder: string }>): Promise<{ project: string; folder: string }> {
  const cleaned = cleanLocalPath(cwd);
  const key = pathKey(cleaned);
  const cached = cache.get(key);
  if (cached) return cached;
  const folder = basename(cleaned) || cleaned;
  let current = cleaned;
  let project = folder;
  const worktree = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)(?:[\\/]|$)/i.exec(cleaned);
  if (worktree?.[1] && worktree[2]) project = `${basename(worktree[1])} · ${worktree[2]}`;
  for (let depth = 0; depth < 16; depth++) {
    if (await exists(join(current, '.git'))) {
      if (!worktree) project = basename(current) || folder;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const value = { project, folder };
  cache.set(key, value);
  return value;
}

function chooseCandidate(candidates: Candidate[], live: RawLiveClaudeWindow[]): Candidate {
  const liveMatch = candidates.find((candidate) => live.some((window) => window.launchSessionId === candidate.id && window.cwd && pathKey(window.cwd) === pathKey(candidate.cwd) && (!window.configDir || pathKey(window.configDir) === candidate.homeKey)));
  if (liveMatch) return liveMatch;
  return [...candidates].sort((a, b) => Number(a.archived) - Number(b.archived) || b.activityMs - a.activityMs || b.size - a.size)[0]!;
}

function deriveStoreForWindow(raw: RawLiveClaudeWindow, stores: Store[], base: string, accounts: AccountConfig[]): Store {
  if (!raw.configDir) return stores.find((store) => store.homeKey === pathKey(join(base, '.claude'))) ?? accountForClaudeHome(join(base, '.claude'), base, accounts);
  return stores.find((store) => store.homeKey === pathKey(raw.configDir!)) ?? accountForClaudeHome(raw.configDir, base, accounts);
}

async function bindLiveWindows(rawWindows: RawLiveClaudeWindow[], candidates: Candidate[], stores: Store[], base: string, accounts: AccountConfig[], projectCache: ScanState['projectInfo']): Promise<LiveSessionWindow[]> {
  return Promise.all(rawWindows.map(async (raw): Promise<LiveSessionWindow> => {
    const store = deriveStoreForWindow(raw, stores, base, accounts);
    const cwd = raw.cwd ? cleanLocalPath(raw.cwd) : '';
    const startedMs = Date.parse(raw.startedAt);
    const sameWindow = candidates.filter((candidate) => candidate.provider === 'claude' && candidate.homeKey === store.homeKey && cwd && pathKey(candidate.cwd) === pathKey(cwd));
    let sessionId = raw.launchSessionId;
    let binding: LiveSessionWindow['binding'] = raw.launchSessionId ? 'launch' : 'unknown';
    if (!sessionId) {
      const afterStart = sameWindow.filter((candidate) => candidate.activityMs >= startedMs - 120_000);
      const ids = [...new Set(afterStart.map((candidate) => candidate.id))];
      if (ids.length === 1) { sessionId = ids[0]!; binding = 'likely'; }
      else if (ids.length > 1) binding = 'ambiguous';
    }
    const candidate = sessionId ? (sameWindow.find((item) => item.id === sessionId) ?? candidates.find((item) => item.provider === 'claude' && item.id === sessionId)) : undefined;
    const info = await getProjectInfo(cwd || candidate?.cwd || '(unknown)', projectCache);
    return {
      provider: 'claude',
      pid: raw.pid,
      startedAt: raw.startedAt,
      accountId: store.accountId,
      accountLabel: store.accountLabel,
      launcher: store.launcher,
      project: info.project,
      folder: info.folder,
      cwd: cwd || candidate?.cwd || '(unknown)',
      sessionId,
      launchSessionId: raw.launchSessionId,
      binding,
      title: candidate?.title ?? null,
      resumeCommand: sessionId && (cwd || candidate?.cwd) ? buildResumeCommand('claude', store.launcher, store.home, cwd || candidate!.cwd, sessionId) : null,
    };
  }));
}

const ACTIVITY_RANK: Record<WorkSession['activity'], number> = { open: 0, recent: 1, idle: 2, archived: 3 };

export async function scanSessions(deps: SessionsDeps, state: ScanState = { claudeMetadata: new Map(), projectInfo: new Map() }): Promise<SessionsResponse> {
  const now = (deps.now ?? Date.now)();
  const recentHours = deps.recentHours ?? 24;
  const accounts = deps.accounts ?? [];
  const warnings: string[] = [];
  const [claudeStores, codexStores] = await Promise.all([discoverClaudeStores(deps.base, accounts), discoverCodexStores(deps.base, accounts)]);

  const candidates: Candidate[] = [];
  for (const store of claudeStores) {
    try { candidates.push(...await scanClaudeStore(store, state.claudeMetadata)); }
    catch (error) { warnings.push(`Claude sessions (${store.accountLabel}) could not be read: ${(error as Error).message}`); }
  }
  for (const store of codexStores) {
    try { candidates.push(...await scanCodexStore(store)); }
    catch (error) { warnings.push(`Codex sessions (${store.accountLabel}) could not be read: ${(error as Error).message}`); }
  }

  let rawWindows: RawLiveClaudeWindow[] = [];
  try { rawWindows = await (deps.getLiveWindows ? deps.getLiveWindows() : gatherLiveClaudeWindows(deps.run ?? runPwsh)); }
  catch (error) { warnings.push(`Open Claude windows could not be inspected: ${(error as Error).message}`); }
  const windows = (await bindLiveWindows(rawWindows, candidates, claudeStores, deps.base, accounts, state.projectInfo))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const liveById = new Map<string, LiveSessionWindow>();
  for (const window of windows) if (window.sessionId) liveById.set(window.sessionId, window);

  const grouped = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.provider}:${candidate.id}`;
    const group = grouped.get(key) ?? [];
    group.push(candidate);
    grouped.set(key, group);
  }
  const sessions: WorkSession[] = [];
  for (const copies of grouped.values()) {
    const chosen = chooseCandidate(copies, rawWindows);
    const live = chosen.provider === 'claude' ? liveById.get(chosen.id) : undefined;
    const info = await getProjectInfo(live?.cwd ?? chosen.cwd, state.projectInfo);
    const activity: WorkSession['activity'] = live ? 'open' : chosen.archived ? 'archived' : chosen.activityMs >= now - recentHours * 3_600_000 ? 'recent' : 'idle';
    sessions.push({
      provider: chosen.provider,
      id: chosen.id,
      title: chosen.title,
      accountId: live?.accountId ?? chosen.accountId,
      accountLabel: live?.accountLabel ?? chosen.accountLabel,
      launcher: live?.launcher ?? chosen.launcher,
      availableLaunchers: [...new Set(copies.map((copy) => copy.launcher))].sort(),
      project: info.project,
      folder: info.folder,
      cwd: live?.cwd ?? chosen.cwd,
      branch: chosen.branch,
      lastActivity: new Date(chosen.activityMs).toISOString(),
      activity,
      pid: live?.pid ?? null,
      resumeCommand: live?.resumeCommand ?? buildResumeCommand(chosen.provider, chosen.launcher, chosen.home, chosen.cwd, chosen.id),
    });
  }
  sessions.sort((a, b) => ACTIVITY_RANK[a.activity] - ACTIVITY_RANK[b.activity] || Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
  return { windows, sessions, generatedAt: new Date(now).toISOString(), recentHours, partial: warnings.length > 0, warnings };
}

export function makeGetSessions(deps: SessionsDeps): () => Promise<SessionsResponse> {
  const cacheMs = deps.cacheMs ?? 15_000;
  const clock = deps.now ?? Date.now;
  const state: ScanState = { claudeMetadata: new Map(), projectInfo: new Map() };
  let cached: SessionsResponse | null = null;
  let cachedAt = -Infinity;
  let inflight: Promise<SessionsResponse> | null = null;
  return async () => {
    const now = clock();
    if (cached && now - cachedAt < cacheMs) return cached;
    if (inflight) return inflight;
    inflight = scanSessions(deps, state).then((value) => {
      cached = value;
      cachedAt = clock();
      inflight = null;
      return value;
    }, (error) => {
      inflight = null;
      throw error;
    });
    return inflight;
  };
}
