const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function actionBtn(action, attrs, text) {
  return `<button class="svc-act" data-action="${esc(action)}" ${attrs}>${esc(text)}</button>`;
}

function row(s) {
  const hermesMeta = [
    s.pid ? `pid ${s.pid}` : '',
    s.subscription || '',
    s.checkedAt ? `checked ${new Date(s.checkedAt).toLocaleTimeString()}` : '',
    s.autoHeal ? 'auto-heal on' : '',
    s.consecutiveFailures ? `${s.consecutiveFailures} failed checks` : '',
  ].filter(Boolean).join(' · ');
  const meta = s.kind === 'task'
    ? `last ${s.lastRun || '—'}${s.nextRun ? ` · next ${s.nextRun}` : ''}`
    : s.kind === 'hermes'
      ? hermesMeta
    : (s.pid ? `pid ${s.pid}` : s.detail);
  const acts = s.taskName
    ? actionBtn('restart', `data-id="${esc(s.id)}"`, 'restart') + actionBtn('stop', `data-id="${esc(s.id)}"`, 'stop')
    : '';
  return `<div class="svc status-${esc(s.status)}">`
    + `<span class="svc-dot"></span>`
    + `<span class="svc-label">${esc(s.label)}</span>`
    + `<span class="svc-kind">${esc(s.kind)}</span>`
    + `<span class="svc-detail">${esc(s.detail)}</span>`
    + `<span class="svc-meta">${esc(meta)}</span>`
    + `<span class="svc-acts">${acts}</span>`
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
      + `<span class="svc-meta">${u.pid > 0 ? 'pid ' + esc(u.pid) : ''}</span>`
      + `<span class="svc-acts">${u.pid > 0 ? actionBtn('register', `data-pid="${esc(u.pid)}"`, 'register') : ''}</span>`
      + `</div>`).join('');
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

  async function runAction(action, payload, btn) {
    if (!window.confirm(`${action} this service?`)) return;
    btn.disabled = true;
    try {
      const res = await fetch('/api/services/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...payload }) });
      const r = await res.json();
      if (!r.ok) alert(`${action} failed: ${r.error || res.status}`);
    } catch (e) { alert(`${action} failed: ${e}`); }
    finally { btn.disabled = false; refresh(); }
  }
  el.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.svc-act');
    if (!btn) return;
    const action = btn.dataset.action;
    const payload = btn.dataset.id ? { id: btn.dataset.id } : { pid: Number(btn.dataset.pid) };
    runAction(action, payload, btn);
  });
}
