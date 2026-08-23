import type { AccountConfig, NormalizedUsage, UsageWindow } from '../types.ts';
import { StaleCredentialsError } from '../auth/claude.ts';
import { baseUsage } from './shell.ts';
import { fetchWithRetry } from './http.ts';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function toWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as { utilization?: unknown; resets_at?: unknown };
  if (typeof w.utilization !== 'number') return null;
  // The API sends resets_at: null for a freshly-reset / 0% window (seen after the Fable-launch
  // global reset). Keep it null — faking epoch 0 rendered as a misleading "resets now".
  const resetsAt = typeof w.resets_at === 'string' ? new Date(w.resets_at).toISOString() : null;
  return { utilization: w.utilization, resetsAt };
}

/**
 * The Fable/Claude-5 weekly cap is not a top-level field — it arrives inside the `limits[]` array
 * as a `weekly_scoped` entry scoped to model "Fable" (all the legacy `seven_day_*` fields are null
 * now). Match by `scope.model.display_name` so we're robust to array order and to which `kind` slot
 * the API uses. Entries carry `percent` (not `utilization`) + `resets_at`.
 *
 * `access` = the account exposes a Fable-scoped limit at all → it has Fable/Claude-5 access. Plans
 * without Fable access don't get the entry (access=false, window=null). This is the per-account
 * has/no-access fact the dashboard needs, distinct from a present-but-0% window.
 */
function fableUsage(body: Record<string, unknown>): { window: UsageWindow | null; access: boolean } {
  const limits = body['limits'];
  if (!Array.isArray(limits)) return { window: null, access: false };
  for (const item of limits) {
    if (!item || typeof item !== 'object') continue;
    const l = item as { percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: unknown } } };
    if (l.scope?.model?.display_name !== 'Fable') continue;
    // Entry present → the account has Fable access, even if percent is malformed/absent.
    if (typeof l.percent !== 'number') return { window: null, access: true };
    const resetsAt = typeof l.resets_at === 'string' ? new Date(l.resets_at).toISOString() : null;
    return { window: { utilization: l.percent, resetsAt }, access: true };
  }
  return { window: null, access: false };
}

export function normalizeClaudeUsage(body: unknown, account: AccountConfig, now: Date = new Date()): NormalizedUsage {
  const b = (body ?? {}) as Record<string, unknown>;
  const fable = fableUsage(b);
  return {
    accountId: account.id,
    label: account.label,
    provider: 'claude',
    session: toWindow(b['five_hour']),
    weekly: toWindow(b['seven_day']),
    weeklyOpus: toWindow(b['seven_day_opus']),
    fable: fable.window,
    fableAccess: fable.access,
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
  // Header set proven by Aperant's reference impl: a bare `sk-ant-oat01-…` setup-token
  // reads /api/oauth/usage with these headers (no User-Agent needed).
  return fetchWithRetry(USAGE_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
    },
  }, { fetchImpl: deps.fetchImpl });
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
    // For read-only sources the fix is at the source (a CLI session / a fresh setup-token), not
    // re-running add-account — subtrack doesn't own those credentials.
    const readonlyHint = 'read-only credential source — refresh it at the source (Claude Code CLI session or a new setup-token)';
    if (res.status === 403) {
      return { ...shell, status: 'auth_error', error: account.credentialsMode === 'readonly' ? `Token rejected (403) — ${readonlyHint}` : 'Token rejected (403) — re-run add-account with a fresh `claude setup-token`' };
    }
    if (res.status === 401) {
      return { ...shell, status: 'auth_error', error: account.credentialsMode === 'readonly' ? `Token expired/invalid (401) — ${readonlyHint}` : 'Token expired/invalid (401) — re-run add-account with a fresh `claude setup-token`' };
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
    if (e instanceof StaleCredentialsError) {
      // Expired read-only token: only its owner (the CLI) may refresh it. Report, don't hammer.
      return { ...shell, status: 'stale', error: msg };
    }
    const isAuth = /refresh failed|no stored .*credentials|add-account/i.test(msg);
    return { ...shell, status: isAuth ? 'auth_error' : 'error', error: msg };
  }
}
