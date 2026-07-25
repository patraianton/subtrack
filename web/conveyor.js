const root = document.getElementById('conveyor');
const updated = document.getElementById('updated');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render(d) {
  if (!d || !d.task) {
    root.innerHTML = '<div class="cv-empty">Нет активной задачи конвейера — файл статуса пуст.</div>';
    return;
  }
  const phase = esc(d.phase ?? '');
  const level = ['ok', 'warn', 'err', 'info'].includes(d.status) ? d.status : 'info';
  const links = Object.entries(d.links ?? {})
    .map(([k, v]) => `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(k)}</a>`) .join('');
  const rows = [...(d.timeline ?? [])].reverse().map((e) => {
    const lv = ['ok', 'warn', 'err'].includes(e.level) ? e.level : 'info';
    return `<li><span class="cv-ts">${esc(e.ts)}</span><span class="cv-dot ${lv}"></span><span>${esc(e.text)}</span></li>`;
  }).join('');
  root.innerHTML = `
    <div class="cv-card">
      <div class="cv-task">${esc(d.project ?? '')}</div>
      <p style="margin:4px 0 10px">${esc(d.task)}</p>
      <span class="cv-phase ${level}">${phase}</span>
      ${d.next ? `<p class="cv-next">Дальше: ${esc(d.next)}</p>` : ''}
      ${d.pulse ? `<p style="margin:6px 0 0;font-size:.85rem;opacity:.75">♥ пульс ${esc(d.pulse.at)} — ${esc(d.pulse.text)}</p>` : ''}
      <div class="cv-links">${links}</div>
    </div>
    <div class="cv-card"><ul class="cv-tl">${rows}</ul></div>`;
  updated.textContent = d.updatedAt ? `обновлено ${new Date(d.updatedAt).toLocaleTimeString('ru-RU')}` : '';
}

async function tick() {
  try {
    const r = await fetch('/api/conveyor', { cache: 'no-store' });
    render(await r.json());
  } catch {
    root.innerHTML = '<div class="cv-empty">API конвейера недоступен.</div>';
  }
}

tick();
setInterval(tick, 5000);
