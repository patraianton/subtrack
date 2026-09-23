import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { SessionsResponse } from '../sessions/types.ts';
import type { FleetResponse, FleetWindow, SetModeRequest, SetModeResult, WindowMode } from './types.ts';
import { applyMode, isWindowMode, markFor, normalizeCwd, readMarks, writeMarks } from './modes.ts';
import { listPanes, type HerdrRunner } from './panes.ts';

/**
 * Thresholds of the external `claude-idle-compact` watchdog (~/.claude/hooks/idle-compact-watch.ps1).
 * Subtrack never compacts anything; it mirrors these bounds only to explain, per window, what that
 * watchdog would do next. Keep them in step with the script.
 */
export const IDLE_WINDOW_MINUTES = { min: 55, max: 24 * 60 } as const;

interface CompactRecord { at?: string; failed?: boolean }

async function readCompactState(base: string): Promise<Record<string, CompactRecord>> {
  try {
    const raw = await readFile(join(base, '.claude', 'idle-compact', 'state.json'), 'utf8');
    const parsed = JSON.parse(raw.replace(/^﻿/, '')) as Record<string, CompactRecord>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

export function makeGetFleet(deps: {
  base: string;
  run: HerdrRunner;
  getSessions: () => Promise<SessionsResponse>;
  /** Accounts with no headroom, keyed by account id with a short human reason. */
  blockedAccounts?: () => Map<string, string>;
  now?: () => number;
}): () => Promise<FleetResponse> {
  const now = deps.now ?? Date.now;
  return async () => {
    const warnings: string[] = [];
    const [paneList, marks, compact, sessions] = await Promise.all([
      listPanes(deps.run),
      readMarks(deps.base),
      readCompactState(deps.base),
      deps.getSessions().catch((e: Error) => { warnings.push(`sessions unavailable: ${e.message}`); return null; }),
    ]);
    if (paneList.warning) warnings.push(paneList.warning);

    const byId = new Map<string, SessionsResponse['sessions'][number]>();
    // An account of 'claude-default' means the home is unknown for that record; the live window
    // of the same folder knows it, so fill the gap by folder rather than showing the wrong account.
    const homeByCwd = new Map<string, { id: string; label: string }>();
    for (const s of sessions?.sessions ?? []) {
      if (s.provider !== 'claude') continue;
      if (s.id) byId.set(s.id, s);
      if (s.pid && s.cwd && s.accountId && s.accountId !== 'claude-default') {
        homeByCwd.set(normalizeCwd(s.cwd), { id: s.accountId, label: s.accountLabel });
      }
    }
    const blocked = deps.blockedAccounts?.() ?? new Map<string, string>();
    const t = now();

    const windows: FleetWindow[] = paneList.panes
      .filter((p) => p.agent === 'claude')
      .map((p) => {
        const session = p.sessionId ? byId.get(p.sessionId) ?? null : null;
        const cwd = normalizeCwd(p.cwd);
        const home = session && session.accountId !== 'claude-default'
          ? { id: session.accountId, label: session.accountLabel }
          : homeByCwd.get(cwd) ?? null;
        const found = markFor(marks, p.paneId, cwd);
        const record = p.sessionId ? compact[p.sessionId] : undefined;
        const lastActivity = session?.lastActivity ?? null;
        const parsed = lastActivity ? Date.parse(lastActivity) : NaN;
        const idleMinutes = Number.isFinite(parsed) ? Math.max(0, Math.round((t - parsed) / 60_000)) : null;
        const { compactable, reason } = verdict({
          mode: found?.mark.mode ?? null,
          agentStatus: p.agentStatus,
          idleMinutes,
          blockedReason: home ? blocked.get(home.id) ?? null : null,
        });
        return {
          paneId: p.paneId,
          workspaceId: p.workspaceId,
          folder: session?.folder || basename(cwd) || cwd,
          cwd,
          title: p.title,
          agentStatus: p.agentStatus,
          sessionId: p.sessionId,
          lastActivity,
          idleMinutes,
          accountId: home?.id ?? null,
          accountLabel: home?.label ?? null,
          mode: found?.mark.mode ?? null,
          markScope: found?.scope ?? null,
          markedAt: found?.mark.set || null,
          lastCompactAt: record?.at ?? null,
          lastCompactFailed: record?.failed === true,
          compactable,
          reason,
        };
      })
      .sort((a, b) => (b.idleMinutes ?? -1) - (a.idleMinutes ?? -1));

    return { windows, generatedAt: new Date(t).toISOString(), warnings, idleWindowMinutes: IDLE_WINDOW_MINUTES };
  };
}

/** What the idle-compaction watchdog would do with this window on its next round, and why. */
export function verdict(w: {
  mode: WindowMode | null;
  agentStatus: string;
  idleMinutes: number | null;
  blockedReason: string | null;
}): { compactable: boolean; reason: string } {
  if (w.mode === 'off') return { compactable: false, reason: 'marked off — never touched' };
  if (w.agentStatus === 'working') return { compactable: false, reason: 'working' };
  if (w.idleMinutes === null) return { compactable: false, reason: 'no activity known' };
  if (w.blockedReason) return { compactable: false, reason: `account has no headroom (${w.blockedReason})` };
  if (w.idleMinutes < IDLE_WINDOW_MINUTES.min) return { compactable: false, reason: `idle ${w.idleMinutes}m — cache still fresh` };
  if (w.idleMinutes > IDLE_WINDOW_MINUTES.max) return { compactable: false, reason: 'idle over 24h — too cold to be worth it' };
  return { compactable: true, reason: 'due on the next round' };
}

export function makeSetWindowMode(deps: { base: string; now?: () => number }): (req: SetModeRequest) => Promise<SetModeResult> {
  const now = deps.now ?? Date.now;
  return async (req) => {
    const mode = req.mode;
    if (mode !== 'auto' && !isWindowMode(mode)) throw new Error('mode must be ever, warm, off or auto');
    const pane = req.pane ? String(req.pane) : null;
    const cwd = normalizeCwd(req.cwd);
    if (!pane && !cwd) throw new Error('pane or cwd required');
    const marks = await readMarks(deps.base);
    await writeMarks(deps.base, applyMode(marks, { pane, cwd, mode, now: new Date(now()) }));
    return { ok: true, mode, pane, cwd };
  };
}
