import { spawn } from 'node:child_process';
import { REMOTE_CODEX_SCAN } from './remoteScript.ts';

/**
 * Codex burn beyond this machine.
 *
 * Anton's rule is that Codex runs on the Mac and on Hetzner, never on Windows — so for most Codex
 * cards the sessions that ate the window are simply not on the machine the dashboard runs on. The
 * only honest answer is to go and read them, which this does: one short-lived `ssh <host> python3 -`
 * per host, with the scan itself (see `remoteScript.ts`) executing there and returning summed rows.
 * No rollout ever crosses the network, and nothing is written on the remote side.
 *
 * A host that is asleep, unreachable, or missing python3 must never break the panel: every failure
 * degrades to a warning on an otherwise complete answer.
 */

export interface RemoteBurnRow {
  /** ChatGPT account id of the home the store belongs to — how a row finds its card. */
  accountId: string;
  sessionId: string;
  cwd: string | null;
  models: Record<string, number>;
  replies: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  firstMs: number;
  lastMs: number;
}

export interface RemoteBurnScan {
  rows: RemoteBurnRow[];
  /** Stores reachable from more than one login there; skipped rather than split, same as locally. */
  shared: string[];
  warnings: string[];
}

/** Runs the scan on `host` and returns its stdout. Injected so tests never touch ssh. */
export type RemoteRunner = (host: string, script: string, args: string[]) => Promise<string>;

export interface SshRunnerOptions {
  timeoutMs?: number;
  connectTimeoutSeconds?: number;
}

export function makeSshRunner(options: SshRunnerOptions = {}): RemoteRunner {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const connectTimeout = options.connectTimeoutSeconds ?? 8;
  return (host, script, args) => new Promise<string>((resolve, reject) => {
    // BatchMode keeps a host with a missing/locked key from sitting on a password prompt forever.
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeout}`, host, 'python3', '-', ...args], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split('\n').slice(-1)[0] || `ssh exited with ${code}`));
    });
    child.stdin.end(script);
  });
}

function toRow(raw: Record<string, unknown>): RemoteBurnRow | null {
  const num = (key: string): number => (typeof raw[key] === 'number' ? (raw[key] as number) : 0);
  const accountId = raw['accountId'];
  const sessionId = raw['sessionId'];
  if (typeof accountId !== 'string' || typeof sessionId !== 'string') return null;
  const models = raw['models'];
  return {
    accountId,
    sessionId,
    cwd: typeof raw['cwd'] === 'string' ? raw['cwd'] : null,
    models: models && typeof models === 'object' ? (models as Record<string, number>) : {},
    replies: num('replies'),
    input: num('input'),
    cacheWrite: num('cacheWrite'),
    cacheRead: num('cacheRead'),
    output: num('output'),
    firstMs: num('firstMs'),
    lastMs: num('lastMs'),
  };
}

export async function scanRemoteHost(host: string, windowStartMs: number, nowMs: number, run: RemoteRunner): Promise<RemoteBurnScan> {
  const stdout = await run(host, REMOTE_CODEX_SCAN, [String(Math.round(windowStartMs)), String(Math.round(nowMs))]);
  let parsed: { rows?: unknown[]; shared?: unknown[]; warnings?: unknown[] };
  try { parsed = JSON.parse(stdout.trim().split('\n').slice(-1)[0] ?? ''); }
  catch { throw new Error('unreadable answer (not JSON)'); }
  return {
    rows: (parsed.rows ?? []).map((row) => toRow(row as Record<string, unknown>)).filter((row): row is RemoteBurnRow => row !== null),
    shared: (parsed.shared ?? []).filter((entry): entry is string => typeof entry === 'string'),
    warnings: (parsed.warnings ?? []).filter((entry): entry is string => typeof entry === 'string'),
  };
}

/**
 * One scan per host and window, shared by every card on the page: the hosts hold every subscription's
 * sessions, so expanding four Codex cards must not mean four ssh trips to the same Mac.
 */
export function makeRemoteScanner(run: RemoteRunner, cacheMs = 30_000, clock: () => number = Date.now) {
  const cached = new Map<string, { at: number; value: Promise<RemoteBurnScan> }>();
  return (host: string, windowStartMs: number, nowMs: number): Promise<RemoteBurnScan> => {
    const key = `${host}|${Math.round(windowStartMs)}`;
    const now = clock();
    const hit = cached.get(key);
    if (hit && now - hit.at < cacheMs) return hit.value;
    const value = scanRemoteHost(host, windowStartMs, nowMs, run);
    cached.set(key, { at: now, value });
    // A failed trip must not be remembered as an answer for the next 30 seconds.
    value.catch(() => { if (cached.get(key)?.value === value) cached.delete(key); });
    return value;
  };
}
