import type { AccountConfig, NormalizedUsage, UsageWindow } from '../types.ts';
import { baseUsage } from './shell.ts';
import { fetchWithRetry } from './http.ts';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const SESSION_SECONDS = 18_000;   // 5-hour window  (verified live, Task 9 spike)
const WEEKLY_SECONDS = 604_800;   // 7-day window

// Real wham/usage shape (verified 2026-06-29): windows are nested under `rate_limit`
// as primary_window/secondary_window, each with used_percent + limit_window_seconds + reset_at (unix s).
interface RawWindow { used_percent?: number; limit_window_seconds?: number; reset_at?: number }
interface RawRateLimit { primary_window?: RawWindow; secondary_window?: RawWindow }

function toWindow(w: RawWindow | undefined): UsageWindow | null {
  if (!w || typeof w.used_percent !== 'number') return null;
  // Null reset when the API omits reset_at, rather than faking epoch 0 (renders as "resets now").
  const resetsAt = typeof w.reset_at === 'number' ? new Date(w.reset_at * 1000).toISOString() : null;
  return { utilization: w.used_percent, resetsAt };
}

// Assign each present window to session (≈5h) or weekly (≈7d) by its limit_window_seconds,
// so mapping is robust regardless of which slot (primary/secondary) the API uses.
function classify(windows: RawWindow[]): { session?: RawWindow; weekly?: RawWindow } {
  const out: { session?: RawWindow; weekly?: RawWindow } = {};
  for (const w of windows) {
    const secs = w.limit_window_seconds ?? 0;
    const isSession = Math.abs(secs - SESSION_SECONDS) <= Math.abs(secs - WEEKLY_SECONDS);
    if (isSession) { if (!out.session) out.session = w; }
    else if (!out.weekly) out.weekly = w;
  }
  return out;
}

export function normalizeCodexUsage(snapshot: unknown, account: AccountConfig, now: Date = new Date()): NormalizedUsage {
  const rl = (snapshot as { rate_limit?: RawRateLimit } | null)?.rate_limit;
  const windows = [rl?.primary_window, rl?.secondary_window].filter(
    (w): w is RawWindow => !!w && typeof (w as RawWindow).used_percent === 'number',
  );
  const { session: sessionRaw, weekly: weeklyRaw } = classify(windows);
  const session = toWindow(sessionRaw);
  const weekly = toWindow(weeklyRaw);
  // The wham/usage 200-body shape was unverified at design time (§7.2/§15). If no
  // rate-limit windows resolve, treat it as an error rather than a silent "ok" with empty bars.
  if (!session && !weekly) {
    return {
      accountId: account.id, label: account.label, provider: 'codex',
      session: null, weekly: null, weeklyOpus: null, fable: null, fableAccess: false,
      status: 'error', lastUpdated: now.toISOString(),
      error: 'Unexpected wham/usage response (no rate-limit windows found)', retryAt: null,
    };
  }
  return {
    accountId: account.id, label: account.label, provider: 'codex',
    session, weekly, weeklyOpus: null, fable: null, fableAccess: false,
    status: 'ok', lastUpdated: now.toISOString(), error: null, retryAt: null,
  };
}

export interface CodexFetchDeps {
  readAuth(home: string, opts?: { externalOwner?: boolean }): Promise<{ accessToken: string; accountId: string }>;
  fetchImpl?: typeof fetch;
}

export async function fetchCodexUsage(account: AccountConfig, deps: CodexFetchDeps, now: Date = new Date()): Promise<NormalizedUsage> {
  const shell = baseUsage(account, 'codex', now);
  if (!account.credentialsHome) {
    return { ...shell, status: 'auth_error', error: 'No credentialsHome configured — run add-account' };
  }
  let credentials: { accessToken: string; accountId: string };
  try {
    credentials = await deps.readAuth(account.credentialsHome, { externalOwner: account.credentialsMode === 'readonly' });
  } catch (e) {
    return { ...shell, status: 'auth_error', error: e instanceof Error ? e.message : String(e) };
  }
  try {
    const { accessToken, accountId } = credentials;
    const res = await fetchWithRetry(USAGE_URL, {
      headers: { authorization: `Bearer ${accessToken}`, 'chatgpt-account-id': accountId },
    }, { fetchImpl: deps.fetchImpl });
    if (res.status === 401) {
      return account.credentialsMode === 'readonly'
        ? { ...shell, status: 'auth_error', error: 'Externally-owned Codex token rejected — repair/refresh it with the owning Hermes login' }
        : { ...shell, status: 'auth_error', error: `Codex token expired — run: codex login (CODEX_HOME=${account.credentialsHome})` };
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
