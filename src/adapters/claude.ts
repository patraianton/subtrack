import type { AccountConfig, NormalizedUsage, UsageWindow } from '../types.ts';
import { baseUsage } from './shell.ts';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function toWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as { utilization?: unknown; resets_at?: unknown };
  if (typeof w.utilization !== 'number') return null;
  const resetsAt = typeof w.resets_at === 'string' ? new Date(w.resets_at).toISOString() : new Date(0).toISOString();
  return { utilization: w.utilization, resetsAt };
}

export function normalizeClaudeUsage(body: unknown, account: AccountConfig, now: Date = new Date()): NormalizedUsage {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    accountId: account.id,
    label: account.label,
    provider: 'claude',
    session: toWindow(b['five_hour']),
    weekly: toWindow(b['seven_day']),
    weeklyOpus: toWindow(b['seven_day_opus']),
    status: 'ok',
    lastUpdated: now.toISOString(),
    error: null,
    retryAt: null,
  };
}

export interface ClaudeFetchDeps {
  getAccessToken(id: string, opts?: { force?: boolean }): Promise<string>;
  fetchImpl?: typeof fetch;
  clientVersion?: string;
}

async function callUsage(token: string, deps: ClaudeFetchDeps): Promise<Response> {
  const f = deps.fetchImpl ?? fetch;
  // Header set proven by Aperant's reference impl: a bare `sk-ant-oat01-…` setup-token
  // reads /api/oauth/usage with these headers (no User-Agent needed).
  return f(USAGE_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
    },
  });
}

export async function fetchClaudeUsage(account: AccountConfig, deps: ClaudeFetchDeps, now: Date = new Date()): Promise<NormalizedUsage> {
  const shell = baseUsage(account, 'claude', now);
  try {
    let token = await deps.getAccessToken(account.id);
    let res = await callUsage(token, deps);
    if (res.status === 401) {
      token = await deps.getAccessToken(account.id, { force: true });
      res = await callUsage(token, deps);
    }
    if (res.status === 403) {
      return { ...shell, status: 'auth_error', error: 'Token rejected (403) — re-run add-account with a fresh `claude setup-token`' };
    }
    if (res.status === 401) {
      return { ...shell, status: 'auth_error', error: 'Token expired/invalid (401) — re-run add-account with a fresh `claude setup-token`' };
    }
    if (res.status === 429) {
      return { ...shell, status: 'throttled', error: 'Rate limited (HTTP 429)' };
    }
    if (!res.ok) {
      return { ...shell, status: 'error', error: `HTTP ${res.status}` };
    }
    return normalizeClaudeUsage(await res.json(), account, now);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isAuth = /refresh failed|no stored .*credentials|add-account/i.test(msg);
    return { ...shell, status: isAuth ? 'auth_error' : 'error', error: msg };
  }
}
