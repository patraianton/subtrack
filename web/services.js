const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function row(s) {
  const meta = s.kind === 'task'
    ? `last ${s.lastRun || '—'}${s.nextRun ? ` · next ${s.nextRun}` : ''}`
    : (s.pid ? `pid ${s.pid}` : s.detail);
  return `<div class="svc status-${esc(s.status)}">`
    + `<span class="svc-dot"></span>`
    + `<span class="svc-label">${esc(s.label)}</span>`
    + `<span class="svc-kind">${esc(s.kind)}</span>`
    + `<span class="svc-detail">${esc(s.detail)}</span>`
    + `<span class="svc-meta">${esc(meta)}</span>`
    + `</div>`;
}

function group(name, items) {
  return `<h2 class="svc-group">${esc(name || 'other')}</h2>` + items.map(row).join('');
}

export function renderServices(data, _now) {
  const byGroup = new Map();
  for (const s of data.services) {
    const g = s.group || 'other';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(s);
  }
  let html = '';
  for (const [name, items] of byGroup) html += group(name, items);
  if (data.untracked && data.untracked.length) {
    html += `<h2 class="svc-group untracked">Untracked runners</h2>`;
    html += data.untracked.map((u) =>
      `<div class="svc status-unknown"><span class="svc-dot"></span>`
      + `<span class="svc-label">:${esc(u.port ?? '')}</span>`
      + `<span class="svc-kind">${esc(u.name)}</span>`
      + `<span class="svc-detail">${esc(u.cmd)}</span>`
      + `<span class="svc-meta">${u.pid > 0 ? 'pid ' + u.pid : ''}</span></div>`).join('');
  }
  return html || '<p class="empty">No services configured yet.</p>';
}

// Browser bootstrap (skipped under node:test, which only imports renderServices).
if (typeof document !== 'undefined') {
  const el = document.getElementById('services');
  const updated = document.getElementById('updated');
  async function refresh() {
    try {
      const res = await fetch('/api/services');
      if (!res.ok) { updated.textContent = 'services unavailable'; return; }
      const data = await res.json();
      el.innerHTML = renderServices(data, Date.now());
      updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
    } catch { updated.textContent = 'connection lost — retrying'; }
  }
  refresh();
  setInterval(refresh, 15000);
}
