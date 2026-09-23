import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { SessionsResponse } from '../sessions/types.ts';
import type { FleetResponse, FleetWindow, HerdrWorkspace, SetModeRequest, SetModeResult, WindowMode } from './types.ts';
import { applyMode, isWindowMode, markFor, normalizeCwd, readMarks, writeMarks } from './modes.ts';
import { listPanes, listWorkspaces, type HerdrRunner } from './panes.ts';
import { readBranch } from './branch.ts';

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
    const [paneList, workspaces, marks, compact, sessions] = await Promise.all([
      listPanes(deps.run),
      listWorkspaces(deps.run),
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
    const sidebar = sidebarOrder(workspaces);
    const claudePanes = paneList.panes.filter((p) => p.agent === 'claude');
    // One tiny .git read per window instead of a git process each; sixty of those would be slow.
    const branches = new Map<string, string | null>();
    await Promise.all([...new Set(claudePanes.map((p) => normalizeCwd(p.cwd)))]
      .map(async (cwd) => { branches.set(cwd, await readBranch(cwd)); }));

    const windows: FleetWindow[] = claudePanes
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
        const place = p.workspaceId ? sidebar.get(p.workspaceId) ?? null : null;
        return {
          paneId: p.paneId,
          workspaceId: p.workspaceId,
          folder: session?.folder || basename(cwd) || cwd,
          cwd,
          title: p.title,
          workspaceLabel: place?.ws.label || null,
          workspaceNumber: place ? place.ws.number : null,
          repoName: place?.ws.repoName ?? null,
          isWorktree: place?.ws.isWorktree ?? false,
          depth: place?.depth ?? 0,
          branch: branches.get(cwd) ?? null,
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
      // The operator's own order, not ours: reading the page must not mean re-finding every
      // window in a different arrangement than the herdr sidebar it mirrors.
      .sort((a, b) => {
        const pa = a.workspaceId ? sidebar.get(a.workspaceId) : undefined;
        const pb = b.workspaceId ? sidebar.get(b.workspaceId) : undefined;
        return (pa?.group ?? Number.MAX_SAFE_INTEGER) - (pb?.group ?? Number.MAX_SAFE_INTEGER)
          || (pa?.depth ?? 0) - (pb?.depth ?? 0)
          || (pa?.ws.number ?? Number.MAX_SAFE_INTEGER) - (pb?.ws.number ?? Number.MAX_SAFE_INTEGER)
          || a.paneId.localeCompare(b.paneId);
      });

    return { windows, generatedAt: new Date(t).toISOString(), warnings, idleWindowMinutes: IDLE_WINDOW_MINUTES };
  };
}

/**
 * Where each workspace sits in the herdr sidebar: repos in the order of their first workspace,
 * and each repo's linked worktrees nested under it — the shape herdr draws. A workspace with no
 * repo (or the only one of its repo) is its own group and stays flat.
 */
export function sidebarOrder(
  workspaces: HerdrWorkspace[],
): Map<string, { ws: HerdrWorkspace; group: number; depth: number }> {
  const groups = new Map<string, HerdrWorkspace[]>();
  for (const ws of workspaces) {
    const key = ws.repoKey ?? `solo:${ws.workspaceId}`;
    const rows = groups.get(key);
    if (rows) rows.push(ws); else groups.set(key, [ws]);
  }
  const out = new Map<string, { ws: HerdrWorkspace; group: number; depth: number }>();
  for (const rows of groups.values()) {
    const group = Math.min(...rows.map((w) => w.number));
    const hasRoot = rows.some((w) => !w.isWorktree);
    for (const ws of rows) out.set(ws.workspaceId, { ws, group, depth: ws.isWorktree && hasRoot ? 1 : 0 });
  }
  return out;
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
