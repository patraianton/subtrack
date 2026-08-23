export type SessionProvider = 'claude' | 'codex';
export type SessionActivity = 'open' | 'recent' | 'idle' | 'archived';
export type WindowBinding = 'launch' | 'likely' | 'ambiguous' | 'unknown';

export interface WorkSession {
  provider: SessionProvider;
  id: string;
  title: string | null;
  accountId: string;
  accountLabel: string;
  launcher: string;
  availableLaunchers: string[];
  project: string;
  folder: string;
  cwd: string;
  branch: string | null;
  lastActivity: string;
  activity: SessionActivity;
  pid: number | null;
  resumeCommand: string;
}

export interface LiveSessionWindow {
  provider: 'claude';
  pid: number;
  startedAt: string;
  accountId: string;
  accountLabel: string;
  launcher: string;
  project: string;
  folder: string;
  cwd: string;
  sessionId: string | null;
  launchSessionId: string | null;
  binding: WindowBinding;
  title: string | null;
  resumeCommand: string | null;
}

export interface SessionsResponse {
  windows: LiveSessionWindow[];
  sessions: WorkSession[];
  generatedAt: string;
  recentHours: number;
  partial: boolean;
  warnings: string[];
}

export interface RawLiveClaudeWindow {
  pid: number;
  startedAt: string;
  configDir: string | null;
  cwd: string | null;
  launchSessionId: string | null;
}

