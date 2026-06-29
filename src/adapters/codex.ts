import type { AccountConfig, NormalizedUsage, UsageWindow } from '../types.ts';
import { baseUsage } from './shell.ts';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const SESSION_MINUTES = 300;
const WEEKLY_MINUTES = 10080;

interface RawLimit { window_minutes?: number; used_percent?: number; resets_at?: number }

function pickByWindow(limits: RawLimit[], target: number): RawLimit | null {
  let best: RawLimit | null = null;
  let bestDiff = Infinity;
  for (const l of limits) {
    if (typeof l.window_minutes !== 'number') continue;
    const d = Math.abs(l.window_minutes - target);
    if (d < bestDiff) { best = l; bestDiff = d; }
  }
  return best;
}

function toWindow(l: RawLimit | null): UsageWindow | null {
  if (!l || typeof l.used_percent !== 'number') return null;
  return { utilization: l.used_percent, resetsAt: new Date((l.resets_at ?? 0) * 1000).toISOString() };
}

export function normalizeCodexUsage(snapshot: unknown, account: AccountConfig, now: Date = new Date()): NormalizedUsage {
  const s = (snapshot ?? {}) as { primary?: RawLimit; secondary?: RawLimit };
  const limits = [s.primary, s.secondary].filter((x): x is RawLimit => !!x);
  const session = toWindow(pickByWindow(limits, SESSION_MINUTES));
  const weekly = toWindow(pickByWindow(limits, WEEKLY_MINUTES));
  // The wham/usage 200-body shape is the one thing research could not verify live (§7.2/§15).
  // If neither window resolves, treat it as an error rather than a silent "ok" with empty bars.
  if (!session && !weekly) {
    return {
      accountId: account.id, label: account.label, provider: 'codex',
      session: null, weekly: null, weeklyOpus: null,
      status: 'error', lastUpdated: now.toISOString(),
      error: 'Unexpected wham/usage response (no rate-limit windows found)', retryAt: null,
    };
  }
  return {
    accountId: account.id, label: account.label, provider: 'codex',
    session, weekly, weeklyOpus: null,
    status: 'ok', lastUpdated: now.toISOString(), error: null, retryAt: null,
  };
}

export interface CodexFetchDeps {
  readAuth(home: string): Promise<{ accessToken: string; accountId: string }>;
  fetchImpl?: typeof fetch;
}

export async function fetchCodexUsage(account: AccountConfig, deps: CodexFetchDeps, now: Date = new Date()): Promise<NormalizedUsage> {
  const shell = baseUsage(account, 'codex', now);
  if (!account.credentialsHome) {
    return { ...shell, status: 'auth_error', error: 'No credentialsHome configured — run add-account' };
  }
  try {
    const { accessToken, accountId } = await deps.readAuth(account.credentialsHome);
    const f = deps.fetchImpl ?? fetch;
    const res = await f(USAGE_URL, {
      headers: { authorization: `Bearer ${accessToken}`, 'chatgpt-account-id': accountId },
    });
    if (res.status === 401) {
      return { ...shell, status: 'auth_error', error: `Codex token expired — run: codex login (CODEX_HOME=${account.credentialsHome})` };
    }
    if (res.status === 429) {
      return { ...shell, status: 'throttled', error: 'Rate limited (HTTP 429)' };
    }
    if (!res.ok) {
      return { ...shell, status: 'error', error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ...shell, status: 'error', error: 'Non-JSON wham/usage response' };
    }
    const normalized = normalizeCodexUsage(parsed, account, now);
    if (normalized.status === 'error') {
      console.error(`[codex ${account.id}] unexpected wham/usage body: ${text.slice(0, 500)}`);
    }
    return normalized;
  } catch (e) {
    return { ...shell, status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}
