// Rendering for "who burned this window" — the per-session breakdown behind a Claude session bar.
// Shares are a LOCAL ESTIMATE from transcripts; the provider only publishes the window percentage.
// Everything here is plain string building so it stays testable outside a browser.

import { modeButtons } from './modes.js';

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const TOP_ROWS = 6;

/**
 * Which providers keep a local session store worth breaking a window down by. Both the clickable
 * bar and the block underneath it ask this ONE question: they were separate checks once, the Codex
 * bar became clickable while the block stayed Claude-only, and clicking it did visibly nothing.
 */
export function burnSupported(provider) {
  return provider === 'claude' || provider === 'codex';
}

export function shortModel(id) {
  return String(id ?? '').replace(/^claude-/, '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-(\d)$/, ' $1');
}

export function shortPath(path) {
  const parts = String(path ?? '').split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('\\') || 'unknown folder';
}

function clock(value) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const normCwd = (v) => String(v ?? '').replace(/[\\/]+$/, '').toLowerCase();

/**
 * The live herdr window a burn row belongs to, or null. The session id is the honest match; after
 * a `/clear` the window runs a new session the transcript does not know about, so a folder match
 * is the fallback — but only when exactly one window sits in that folder, because worktrees and
 * split panes make "same folder" ambiguous and jumping to the wrong window is worse than no jump.
 * Codex rows carry a `host`: that work ran on another machine and has no window here.
 */
export function paneFor(windows, session) {
  if (!Array.isArray(windows) || windows.length === 0 || session.host) return null;
  const byId = session.id ? windows.find((w) => w.sessionId === session.id) : null;
  if (byId) return byId;
  const cwd = normCwd(session.cwd);
  if (!cwd) return null;
  const sameFolder = windows.filter((w) => normCwd(w.cwd) === cwd);
  return sameFolder.length === 1 ? sameFolder[0] : null;
}

/** @param {{ paneId: string, cwd: string, mode?: string|null } | null} [pane] the live herdr window, if any */
export function burnRow(session, now, pane = null) {
  const models = session.models.slice(0, 2).map(shortModel).join(', ') || '—';
  // Codex sessions usually ran on another machine; say which, or the folder name means nothing.
  const where = session.host ? `<span class="burn-host">${esc(session.host)}</span> ` : '';
  const lastMs = Date.parse(session.lastAt);
  const idleMinutes = Math.max(0, Math.round((now - lastMs) / 60000));
  const when = idleMinutes < 3 ? 'now' : idleMinutes < 60 ? `${idleMinutes}m ago` : clock(lastMs);
  const share = Math.round(session.share);
  // The session id and full path go into the tooltip only — never into visible text, and never
  // into a copyable command; this view is a diagnosis, not a launcher.
  const flag = session.contested
    ? '<span class="burn-flag" title="also run under another account inside this window — the split cannot be proven locally">?</span>'
    : '';
  // A row whose window is still open doubles as the way into it: clicking jumps herdr to that pane,
  // and the care buttons pin the same mark the Windows tab and `ccmode` write. Rows with no live
  // window (closed since, or run on another machine) stay inert.
  const attrs = pane
    ? ` class="burn-row live" data-pane="${esc(pane.paneId)}" data-cwd="${esc(pane.cwd)}"`
    : ' class="burn-row"';
  const hint = pane ? 'click to open this window in herdr\n' : '';
  const care = pane ? `<span class="burn-care">${modeButtons(pane)}</span>` : '';
  return `<div${attrs} title="${hint}${esc(session.cwd ?? '')}\n${esc(session.id)}">`
    + `<span class="burn-share">${share}%</span>`
    + `<span class="burn-bar"><span style="width:${Math.min(share, 100)}%"></span></span>`
    + `<span class="burn-what">${where}${esc(shortPath(session.cwd))}${flag}</span>`
    + `<span class="burn-meta">${esc(models)} · ${Number(session.replies) || 0} replies · ${esc(when)}</span>${care}</div>`;
}

/**
 * `state` is undefined | {loading} | {error} | {data}; `windows` are the live herdr panes from
 * /api/fleet, used only to decide which rows can be jumped to and marked.
 */
export function renderBurn(state, now, windows = []) {
  if (!state || state.loading) return '<div class="burn"><div class="burn-note">reading local transcripts…</div></div>';
  if (state.error) return `<div class="burn"><div class="burn-note err">${esc(state.error)}</div></div>`;
  const data = state.data;
  if (!data.sessions.length) {
    const why = data.warnings.length ? data.warnings.join(' · ') : 'no local session activity in this window';
    return `<div class="burn"><div class="burn-note">${esc(why)}</div></div>`;
  }
  const rows = data.sessions.slice(0, TOP_ROWS).map((session) => burnRow(session, now, paneFor(windows, session))).join('');
  const rest = data.sessions.slice(TOP_ROWS);
  const restShare = Math.round(rest.reduce((sum, session) => sum + session.share, 0));
  const more = rest.length
    ? `<div class="burn-row muted"><span class="burn-share">${restShare}%</span><span class="burn-bar"></span>`
      + `<span class="burn-what">+${rest.length} more session${rest.length === 1 ? '' : 's'}</span><span class="burn-meta"></span></div>`
    : '';
  const other = data.otherSessions
    ? ` · ${data.otherSessions} session${data.otherSessions === 1 ? '' : 's'} of other accounts ignored`
    : '';
  // "local" would be a lie for Codex: those rows are usually read off the Mac or Hetzner.
  const note = `<div class="burn-note">estimate from session records · window from ${esc(clock(data.windowStart))}${other}</div>`;
  return `<div class="burn">${rows}${more}${note}</div>`;
}
