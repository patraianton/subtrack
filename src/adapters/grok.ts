import type { AccountConfig, NormalizedUsage } from '../types.ts';
import { baseUsage } from './shell.ts';
import { fetchWithRetry } from './http.ts';

const RATE_LIMITS_URL = 'https://grok.com/rest/rate-limits';
const GET_USER_URL = 'https://grok.com/rest/auth/get-user';
// The tracked allowance: grok-4 DEFAULT is the main per-model 2-hour window on SuperGrok
// (verified live 2026-08-21: {"windowSizeSeconds":7200,"remainingQueries":90,"totalQueries":90};
// grok-3 and grok-4-heavy have their own windows we don't currently surface).
const REQUEST_BODY = JSON.stringify({ requestKind: 'DEFAULT', modelName: 'grok-4' });
// Cloudflare fronts grok.com but answers plain non-browser clients with clean JSON (verified
// 2026-08-21: cookieless POST → JSON 401, no challenge). Send a browser-like UA anyway so the
// request matches the browser session the cookie came from.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

// Verified live response shape. waitTimeSeconds is reported only for an exhausted window
// (observed community contract; absent while queries remain).
interface RawRateLimits { windowSizeSeconds?: number; remainingQueries?: number; totalQueries?: number; waitTimeSeconds?: number }

export function normalizeGrokUsage(snapshot: unknown, account: AccountConfig, now: Date = new Date()): NormalizedUsage {
  const shell = baseUsage(account, 'grok', now);
  const r = snapshot as RawRateLimits | null;
  const total = r?.totalQueries;
  const remaining = r?.remainingQueries;
  if (typeof total !== 'number' || typeof remaining !== 'number' || total <= 0) {
    return { ...shell, status: 'error', error: 'Unexpected rate-limits response (no remaining/total queries found)' };
  }
  const used = Math.min(Math.max(total - remaining, 0), total);
  // The API anchors no reset time while queries remain — keep resetsAt null rather than faking
  // one from windowSizeSeconds (the window is rolling, not aligned to "now").
  const resetsAt = typeof r?.waitTimeSeconds === 'number' && r.waitTimeSeconds > 0
    ? new Date(now.getTime() + r.waitTimeSeconds * 1000).toISOString()
    : null;
  return {
    ...shell,
    session: { utilization: (used / total) * 100, resetsAt },
    status: 'ok',
  };
}

export interface GrokFetchDeps {
  readCookie(home: string): Promise<string>;
  fetchImpl?: typeof fetch;
}

export async function fetchGrokUsage(account: AccountConfig, deps: GrokFetchDeps, now: Date = new Date()): Promise<NormalizedUsage> {
  const shell = baseUsage(account, 'grok', now);
  if (!account.credentialsHome) {
    return { ...shell, status: 'auth_error', error: 'No credentialsHome configured — run add-account' };
  }
  let cookie: string;
  try {
    cookie = await deps.readCookie(account.credentialsHome);
  } catch (e) {
    return { ...shell, status: 'auth_error', error: e instanceof Error ? e.message : String(e) };
  }
  try {
    const res = await fetchWithRetry(RATE_LIMITS_URL, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: REQUEST_BODY,
    }, { fetchImpl: deps.fetchImpl });
    if (res.status === 401 || res.status === 403) {
      return { ...shell, status: 'auth_error', error: `Grok cookie rejected (HTTP ${res.status}) — re-copy the Cookie header from a logged-in grok.com tab into cookie.txt` };
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
      return { ...shell, status: 'error', error: 'Non-JSON rate-limits response' };
    }
    const normalized = normalizeGrokUsage(parsed, account, now);
    if (normalized.status === 'error') {
      console.error(`[grok ${account.id}] unexpected rate-limits body: ${text.slice(0, 500)}`);
    }
    return normalized;
  } catch (e) {
    return { ...shell, status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

/** Best-effort account email for default labels (registration-time only). Empty string on any failure. */
export async function fetchGrokEmail(cookie: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const res = await fetchImpl(GET_USER_URL, { headers: { cookie, 'user-agent': USER_AGENT } });
    if (!res.ok) return '';
    const parsed = await res.json() as { email?: string };
    return typeof parsed.email === 'string' ? parsed.email : '';
  } catch {
    return '';
  }
}
