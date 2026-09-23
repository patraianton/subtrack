const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MODES = [
  ['auto', 'auto', 'General rule: warmed while you worked here recently, compacted after an hour idle.'],
  ['warm', 'warm', 'Keep the cache warm, never compact.'],
  ['off', 'off', 'Leave this window completely alone — no warming, no compaction.'],
  ['ever', 'ever', 'Forever window: always warm, and cleared with a handover once the context fills up.'],
];

export function formatIdle(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function modeButtons(w) {
  const current = w.mode ?? 'auto';
  return MODES.map(([mode, text, title]) => {
    const on = mode === current ? ' on' : '';
    return `<button class="fl-mode${on}" data-pane="${esc(w.paneId)}" data-cwd="${esc(w.cwd)}" data-mode="${mode}" title="${esc(title)}">${esc(text)}</button>`;
  }).join('');
}

function row(w) {
  const marked = w.mode
    ? `marked ${esc(w.mode)}${w.markScope === 'folder' ? ' (whole folder)' : ''}${w.markedAt ? ` · ${esc(w.markedAt)}` : ''}`
    : '';
  const compacted = w.lastCompactAt
    ? `<span class="fl-note${w.lastCompactFailed ? ' bad' : ''}">last compaction ${esc(String(w.lastCompactAt).replace('T', ' '))}${w.lastCompactFailed ? ' — failed' : ''}</span>`
    : '';
  return `<div class="fl-row${w.compactable ? ' due' : ''}">`
    + `<span class="fl-folder">${esc(w.folder)}</span>`
    + `<span class="fl-pane">${esc(w.paneId)}</span>`
    + `<span class="fl-status s-${esc(w.agentStatus)}">${esc(w.agentStatus)}</span>`
    + `<span class="fl-idle">${esc(formatIdle(w.idleMinutes))}</span>`
    + `<span class="fl-acc">${esc(w.accountId ?? '—')}</span>`
    + `<span class="fl-modes">${modeButtons(w)}</span>`
    + `<span class="fl-reason">${esc(w.reason)}</span>`
    + `<span class="fl-sub">${esc(w.title ?? '')}</span>`
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
  const head = `<p class="fl-lead">${windows.length} Claude windows · ${off} marked off · ${due} due for compaction on the next round `
    + `(idle ${data.idleWindowMinutes?.min ?? 55}m–${Math.round((data.idleWindowMinutes?.max ?? 1440) / 60)}h).</p>`;
  const header = '<div class="fl-row fl-head">'
    + '<span>folder</span><span>pane</span><span>state</span><span>idle</span><span>account</span><span>care</span><span>watchdog</span>'
    + '<span></span><span></span></div>';
  return warn + head + header + windows.map(row).join('');
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
    const btn = ev.target.closest('button.fl-mode');
    if (!btn || busy) return;
    busy = true;
    btn.parentElement.querySelectorAll('button.fl-mode').forEach((b) => b.classList.toggle('on', b === btn));
    try {
      const res = await fetch('/api/fleet/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pane: btn.dataset.pane, cwd: btn.dataset.cwd, mode: btn.dataset.mode }),
      });
      if (!res.ok) updated.textContent = `could not set mode (${res.status})`;
    } catch {
      updated.textContent = 'could not set mode';
    } finally {
      busy = false;
      await refresh();
    }
  });

  refresh();
  setInterval(refresh, 15000);
}
