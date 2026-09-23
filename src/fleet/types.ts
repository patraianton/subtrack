/** Window marks and the herdr pane fleet they apply to. */

/** Care mode a human pinned on a window; `null` in a row means "no mark, general rule". */
export type WindowMode = 'ever' | 'warm' | 'off';

/**
 * One row of `~/.claude/idle-handover/window-modes.json`. The file is shared with the `ccmode`
 * PowerShell function and read by the cache warmer and the idle-compaction watchdog, so the
 * shape (`cwd` / `pane` / `mode` / `set`) is a contract, not an internal detail.
 */
export interface ModeMark {
  cwd: string;
  pane: string | null;
  mode: WindowMode;
  /** 'yyyy-MM-dd HH:mm' local time, exactly as ccmode writes it. */
  set: string;
}

/** A pane as herdr reports it, reduced to the fields this surface needs. */
export interface HerdrPane {
  paneId: string;
  workspaceId: string | null;
  /** The tab holding the pane; focusing a window means focusing its workspace and then this tab. */
  tabId: string | null;
  agent: string;
  agentStatus: string;
  cwd: string;
  sessionId: string | null;
  title: string | null;
  focused: boolean;
}

export interface FleetWindow {
  paneId: string;
  workspaceId: string | null;
  folder: string;
  cwd: string;
  title: string | null;
  agentStatus: string;
  sessionId: string | null;
  lastActivity: string | null;
  idleMinutes: number | null;
  accountId: string | null;
  accountLabel: string | null;
  mode: WindowMode | null;
  /** How the mark was matched: on this exact pane, or on every window in the folder. */
  markScope: 'pane' | 'folder' | null;
  markedAt: string | null;
  lastCompactAt: string | null;
  lastCompactFailed: boolean;
  /** Whether the idle-compaction watchdog would take this window on its next round. */
  compactable: boolean;
  reason: string;
}

export interface FleetResponse {
  windows: FleetWindow[];
  generatedAt: string;
  warnings: string[];
  idleWindowMinutes: { min: number; max: number };
}

export interface SetModeRequest {
  pane?: string | null;
  cwd?: string;
  /** 'auto' removes the mark and returns the window to the general rule (ccmode none). */
  mode: WindowMode | 'auto';
}

export interface SetModeResult {
  ok: boolean;
  mode: WindowMode | 'auto';
  pane: string | null;
  cwd: string;
}

export interface FocusRequest {
  /** herdr pane id, e.g. `w62:p1`. */
  pane: string;
}

export interface FocusResult {
  ok: boolean;
  pane: string;
  workspaceId: string | null;
  /** Whether the terminal window hosting herdr was also brought to the front. */
  raised: boolean;
  warning: string | null;
}
