import { formatCountdown } from '/format.js';

const cardsEl = document.getElementById('cards');
const summaryEl = document.getElementById('summary');
const updatedEl = document.getElementById('updated');
let refreshMs = 30000;
let pollSecs = { claude: 180, codex: 60 };

function gauge(name, w, now) {
  if (!w) return `<div class="gauge"><div class="gauge-top"><span>${name}</span><span>—</span></div><div class="bar"></div></div>`;
  const pct = Math.round(w.utilization);
  return `<div class="gauge"><div class="gauge-top"><span>${name} · ${pct}%</span><span>resets ${formatCountdown(w.resetsAt, now)}</span></div>`
    + `<div class="bar"><div class="fill ${w.severity}" style="width:${Math.min(pct, 100)}%"></div></div></div>`;
}

function isStale(u, now) {
  if (!u.lastUpdated) return false;
  const ttl = (pollSecs[u.provider] || 180) * 1000;
  return now - Date.parse(u.lastUpdated) > ttl * 2;
}

function card(u, now) {
  const opus = u.weeklyOpus ? gauge('weekly · opus', u.weeklyOpus, now) : '';
  const notes = [];
  if (u.status === 'throttled' && u.retryAt) notes.push(`⏳ retry in ${formatCountdown(u.retryAt, now)}`);
  if (u.status !== 'ok' && u.error) notes.push(u.error);
  const note = notes.length ? `<div class="err">${notes.join(' · ')}</div>` : '';
  const ts = u.lastUpdated ? `<span class="cardts">${new Date(u.lastUpdated).toLocaleTimeString()}</span>` : '';
  const stale = isStale(u, now) ? ' stale' : '';
  return `<section class="card ${u.status}${stale}">`
    + `<div class="card-head"><span class="badge">${u.provider}</span><span class="label">${u.label}</span>${ts}<span class="dot ${u.status}"></span></div>`
    + gauge('session', u.session, now) + gauge('weekly', u.weekly, now) + opus + note + `</section>`;
}

function tightest(accounts) {
  let worst = null;
  for (const u of accounts) {
    for (const [kind, w] of [['session', u.session], ['weekly', u.weekly], ['weekly · opus', u.weeklyOpus]]) {
      if (w && (!worst || w.utilization > worst.util)) worst = { label: u.label, kind, util: Math.round(w.utilization) };
    }
  }
  return worst ? `Tightest: ${worst.label} ${worst.kind} ${worst.util}%` : 'No data yet';
}

async function refresh() {
  try {
    const res = await fetch('/api/usage');
    const data = await res.json();
    refreshMs = (data.uiRefreshSeconds || 30) * 1000;
    if (data.pollIntervalSeconds) pollSecs = data.pollIntervalSeconds;
    const now = Date.now();
    cardsEl.innerHTML = data.accounts.map((u) => card(u, now)).join('');
    summaryEl.textContent = tightest(data.accounts);
    updatedEl.textContent = `updated ${new Date(now).toLocaleTimeString()}`;
  } catch {
    updatedEl.textContent = 'connection lost — retrying';
  }
}

refresh();
setInterval(refresh, refreshMs);
