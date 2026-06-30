export type Provider = 'claude' | 'codex';
export type UsageStatus = 'ok' | 'throttled' | 'auth_error' | 'error';
export type Severity = 'ok' | 'warn' | 'crit';

export interface UsageWindow {
  utilization: number; // 0-100, percent used
  resetsAt: string;    // ISO-8601 UTC
}

export interface NormalizedUsage {
  accountId: string;
  label: string;
  provider: Provider;
  session: UsageWindow | null;    // 5-hour window
  weekly: UsageWindow | null;     // 7-day window
  weeklyOpus: UsageWindow | null; // Claude-only separate Opus weekly cap
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
  credentialsHome?: string; // isolated config dir: claude → CLAUDE_CONFIG_DIR, codex → CODEX_HOME
}

export interface SubtrackConfig {
  version: number;
  port: number;
  uiRefreshSeconds: number;
  pollIntervalSeconds: { claude: number; codex: number };
  accounts: AccountConfig[];
}
