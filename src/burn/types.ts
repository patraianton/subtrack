/**
 * Burn = "who ate this account's five-hour session window".
 *
 * Every number here is a LOCAL ESTIMATE read from Claude Code transcripts, not a provider figure.
 * The provider only publishes one percentage per window (`/api/usage`); it never says which session
 * produced it. Shares below are therefore relative weights inside one account's window, useful for
 * ranking sessions, and must never be presented as the provider's own accounting.
 */
export interface BurnSession {
  /** Claude session id — the transcript file name and the `--resume` argument. */
  id: string;
  cwd: string | null;
  /** Last path segment of cwd, for a compact label. */
  project: string | null;
  /** Percent of this account's weighted total inside the window (0-100). */
  share: number;
  weight: number;
  replies: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** Model ids seen in the window, most-used first. */
  models: string[];
  /**
   * The machine whose session store this row was read from, or `null` for the machine running the
   * dashboard. Codex work lives on the Mac and Hetzner, so a Codex window is usually burned by
   * sessions that are not local at all.
   */
  host: string | null;
  firstAt: string;
  lastAt: string;
  /**
   * Another account also has a claim on this session id (it was resumed under a different home) and
   * that claim is fresh enough to fall inside this window. The row is counted here, but the split
   * between the two accounts cannot be proven locally.
   */
  contested: boolean;
}

export interface BurnTotals {
  weight: number;
  replies: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface BurnResponse {
  accountId: string;
  accountLabel: string;
  /** Start of the analysed window (resetsAt minus windowHours, else now minus windowHours). */
  windowStart: string;
  /** Provider reset time this window was anchored to, or null when unknown. */
  resetsAt: string | null;
  windowHours: number;
  sessions: BurnSession[];
  totals: BurnTotals;
  /** Transcripts active in the window that belong to a different home (or to no known home). */
  otherSessions: number;
  generatedAt: string;
  partial: boolean;
  warnings: string[];
}
