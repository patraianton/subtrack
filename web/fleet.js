import { focusWindow, modeButtons, modeLegend, setWindowMode } from './modes.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function formatIdle(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function row(w) {
  const marked = w.mode
    ? `marked ${esc(w.mode)}${w.markScope === 'folder' ? ' (whole folder)' : ''}${w.markedAt ? ` · ${esc(w.markedAt)}` : ''}`
    : '';
  const compacted = w.lastCompactAt
    ? `<span class="fl-note${w.lastCompactFailed ? ' bad' : ''}">last compaction ${esc(String(w.lastCompactAt).replace('T', ' '))}${w.lastCompactFailed ? ' — failed' : ''}</span>`
    : '';
  // The herdr sidebar's own shape: the repo's own window, then its linked worktrees nested under
  // it with the branch underneath, so the page can be read next to the sidebar without re-finding
  // anything. `depth` and the order come from the server; this only draws them.
  const depth = Number(w.depth) || 0;
  const tree = depth ? '<span class="fl-tree">└</span>' : '';
  const wt = w.isWorktree
    ? `<span class="fl-wt" title="a linked git worktree of ${esc(w.repoName ?? 'this repo')}">worktree${w.repoName ? ` · ${esc(w.repoName)}` : ''}</span>`
    : '';
  const branch = w.branch ? `<span class="fl-branch">${esc(w.branch)}</span>` : '';
  // The row itself is the way into the window: a click switches herdr to this pane and raises the
  // terminal. The care buttons sit inside the row, so the handler skips clicks that land on one.
  return `<div class="fl-row go${depth ? ' nested' : ' root'}${w.compactable ? ' due' : ''}" style="--d:${depth}" data-focus="${esc(w.paneId)}" title="open this window in herdr">`
    + `<span class="fl-folder">${tree}${esc(w.workspaceLabel || w.folder)}</span>`
    + `<span class="fl-pane">${esc(w.paneId)}</span>`
    + `<span class="fl-status s-${esc(w.agentStatus)}">${esc(w.agentStatus)}</span>`
    + `<span class="fl-idle">${esc(formatIdle(w.idleMinutes))}</span>`
    + `<span class="fl-acc">${esc(w.accountId ?? '—')}</span>`
    + `<span class="fl-modes">${modeButtons(w)}</span>`
    + `<span class="fl-reason">${esc(w.reason)}</span>`
    + `<span class="fl-sub">${wt}${branch}${esc(w.title ?? '')}</span>`
    + `<span class="fl-sub fl-meta">${marked ? `<span class="fl-note">${marked}</span>` : ''}${compacted}</span>`
    + `</div>`;
}

export function renderFleet(data) {
  const windows = data.windows ?? [];
  const warn = (data.warnings ?? []).length
    ? `<p class="fl-warn">${(data.warnings).map(esc).join(' · ')}</p>`
    : '';
  if (windows.length === 0) {
    return warn + '<p class="empty">No Claude windows reported by herdr.</p>';
  }
  const due = windows.filter((w) => w.compactable).length;
  const off = windows.filter((w) => w.mode === 'off').length;
  const head = `<p class="fl-lead">${windows.length} Claude windows in herdr's own order, worktrees under their repo · `
    + `${off} marked off · ${due} due for compaction on the next round `
    + `(idle ${data.idleWindowMinutes?.min ?? 55}m–${Math.round((data.idleWindowMinutes?.max ?? 1440) / 60)}h).</p>`;
  const header = '<div class="fl-row fl-head">'
    + '<span>window</span><span>pane</span><span>state</span><span>idle</span><span>account</span><span>care</span><span>watchdog</span>'
    + '<span></span><span></span></div>';
  return warn + head + modeLegend('click a row to open that window in herdr; the buttons only set the mark')
    + header + windows.map(row).join('');
}

// Browser bootstrap (skipped under node:test, which only imports the pure renderers).
if (typeof document !== 'undefined') {
  const el = document.getElementById('fleet');
  const updated = document.getElementById('updated');
  let busy = false;

  async function refresh() {
    try {
      const res = await fetch('/api/fleet', { cache: 'no-store' });
      if (!res.ok) { updated.textContent = 'fleet unavailable'; return; }
      el.innerHTML = renderFleet(await res.json());
      updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
    } catch {
      updated.textContent = 'fleet unreachable';
    }
  }

  el.addEventListener('click', async (ev) => {
    if (busy) return;
    const btn = ev.target.closest('button.fl-mode');
    if (btn) {
      busy = true;
      btn.parentElement.querySelectorAll('button.fl-mode').forEach((b) => b.classList.toggle('on', b === btn));
      try {
        await setWindowMode({ pane: btn.dataset.pane, cwd: btn.dataset.cwd, mode: btn.dataset.mode });
      } catch (e) {
        updated.textContent = `could not set mode (${e.message})`;
      } finally {
        busy = false;
        await refresh();
      }
      return;
    }
    const go = ev.target.closest('.fl-row[data-focus]');
    if (!go) return;
    try {
      const r = await focusWindow(go.dataset.focus);
      if (r.warning) updated.textContent = r.warning;
    } catch (e) {
      updated.textContent = `could not open the window (${e.message})`;
    }
  });

  refresh();
  setInterval(refresh, 15000);
}
