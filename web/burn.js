// Rendering for "who burned this window" — the per-session breakdown behind a Claude session bar.
// Shares are a LOCAL ESTIMATE from transcripts; the provider only publishes the window percentage.
// Everything here is plain string building so it stays testable outside a browser.

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

export function burnRow(session, now) {
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
  return `<div class="burn-row" title="${esc(session.cwd ?? '')}\n${esc(session.id)}">`
    + `<span class="burn-share">${share}%</span>`
    + `<span class="burn-bar"><span style="width:${Math.min(share, 100)}%"></span></span>`
    + `<span class="burn-what">${where}${esc(shortPath(session.cwd))}${flag}</span>`
    + `<span class="burn-meta">${esc(models)} · ${Number(session.replies) || 0} replies · ${esc(when)}</span></div>`;
}

/** `state` is undefined | {loading} | {error} | {data}. */
export function renderBurn(state, now) {
  if (!state || state.loading) return '<div class="burn"><div class="burn-note">reading local transcripts…</div></div>';
  if (state.error) return `<div class="burn"><div class="burn-note err">${esc(state.error)}</div></div>`;
  const data = state.data;
  if (!data.sessions.length) {
    const why = data.warnings.length ? data.warnings.join(' · ') : 'no local session activity in this window';
    return `<div class="burn"><div class="burn-note">${esc(why)}</div></div>`;
  }
  const rows = data.sessions.slice(0, TOP_ROWS).map((session) => burnRow(session, now)).join('');
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
