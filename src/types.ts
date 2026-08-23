export type Provider = 'claude' | 'codex' | 'grok';
// 'stale' is read-only-credentials-specific: the source file's token is expired and only its owner
// (e.g. the Claude Code CLI) may refresh it — subtrack must neither refresh nor hammer the API.
export type UsageStatus = 'ok' | 'throttled' | 'auth_error' | 'stale' | 'error';
export type Severity = 'ok' | 'warn' | 'crit';

export interface UsageWindow {
  utilization: number;      // 0-100, percent used
  resetsAt: string | null;  // ISO-8601 UTC, or null when the API hasn't anchored a reset yet
                            // (e.g. a freshly-reset window at 0%) — must NOT be faked as epoch 0
}

export interface NormalizedUsage {
  accountId: string;
  label: string;
  provider: Provider;
  session: UsageWindow | null;    // 5-hour window
  weekly: UsageWindow | null;     // 7-day window
  weeklyOpus: UsageWindow | null; // Claude-only separate Opus weekly cap
  fable: UsageWindow | null;      // Claude-only separate Fable/Claude-5 weekly cap (limits[] weekly_scoped)
  fableAccess: boolean;           // whether the account has Fable/Claude-5 access at all (a Fable-scoped
                                  // weekly limit is present). false for Codex and for Claude plans without it.
                                  // Distinct from fable===null: lets the tile show "no access" vs a 0% window.
  status: UsageStatus;
  lastUpdated: string;            // ISO-8601 UTC
  error: string | null;
  retryAt: string | null;         // ISO-8601 UTC when throttled/frozen
}

export interface AccountConfig {
  id: string;
  label: string;
  provider: Provider;
  enabled: boolean;
  credentialsHome?: string; // isolated config dir: claude → CLAUDE_CONFIG_DIR, codex → CODEX_HOME,
                            // grok → ~/.subtrack/grok-homes/<id> (cookie.txt copied from the browser)
  // 'owned' (default when absent — pre-existing configs migrate as-is): subtrack created the home
  //   via add-account and is the SOLE owner of its refresh token → may auto-refresh + persist.
  // 'readonly': the home belongs to someone else (a live Claude Code CLI/Hermes dir) or holds a
  //   static setup-token. Refresh tokens are single-use, so refreshing here would orphan the real
  //   owner (incident 2026-07-08) — subtrack only ever reads the access token, never refreshes/writes.
  credentialsMode?: 'owned' | 'readonly';
}

export interface SubtrackConfig {
  version: number;
  port: number;
  uiRefreshSeconds: number;
  pollIntervalSeconds: { claude: number; codex: number; grok: number };
  accounts: AccountConfig[];
}
