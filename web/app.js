import { formatCountdown } from '/format.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cardsEl = document.getElementById('cards');
const summaryEl = document.getElementById('summary');
const updatedEl = document.getElementById('updated');
let refreshMs = 30000;
let pollSecs = { claude: 180, codex: 60, grok: 60 };

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

// Fable is a Claude-only entitlement. Show the per-account fact on every Claude tile: a gauge when
// the account has access (even at 0%), or an explicit "no access" marker when it doesn't. Codex
// tiles omit the row entirely (Fable is not applicable there).
function fableRow(u, now) {
  if (u.provider !== 'claude') return '';
  if (u.fable || u.fableAccess) return gauge('weekly · fable', u.fable, now);
  return `<div class="gauge noaccess"><div class="gauge-top"><span>weekly · fable</span><span>no access</span></div><div class="bar"></div></div>`;
}

function card(u, now) {
  const opus = u.weeklyOpus ? gauge('weekly · opus', u.weeklyOpus, now) : '';
  const fable = fableRow(u, now);
  const notes = [];
  if (u.status === 'throttled' && u.retryAt) notes.push(`⏳ retry in ${formatCountdown(u.retryAt, now)}`);
  if (u.status !== 'ok' && u.error) notes.push(u.error);
  const note = notes.length ? `<div class="err">${esc(notes.join(' · '))}</div>` : '';
  const ts = u.lastUpdated ? `<span class="cardts">${new Date(u.lastUpdated).toLocaleTimeString()}</span>` : '';
  const stale = isStale(u, now) ? ' stale' : '';
  // Grok's tracked window is the per-model 2-hour allowance, not a 5h session; label it honestly,
  // and hide the weekly row until Grok's weekly endpoint is wired (no permanently-dashed bar).
  const sessionName = u.provider === 'grok' ? '2h · grok-4' : 'session';
  const weekly = (u.provider === 'grok' && !u.weekly) ? '' : gauge('weekly', u.weekly, now);
  return `<section class="card ${u.provider} ${u.status}${stale}">`
    + `<div class="card-head"><span class="badge ${u.provider}">${u.provider}</span><span class="label">${esc(u.label)}</span>${ts}<span class="dot ${u.status}"></span></div>`
    + gauge(sessionName, u.session, now) + weekly + opus + fable + note + `</section>`;
}

// Group cards by provider (Claude first, then Codex). Within each group the soonest weekly-class
// reset comes first (Anton 2026-08-08: "с какими работать" — ближайший сброс наверху); accounts
// with no known reset sink to the end of their group. Session resets are ignored here — they
// cycle every 5h and would reshuffle the grid constantly.
const PROVIDER_ORDER = { claude: 0, codex: 1, grok: 2 };
function nearestWeeklyReset(u) {
  let t = Infinity;
  for (const w of [u.weekly, u.weeklyOpus, u.fable]) {
    if (w && w.resetsAt) {
      const v = Date.parse(w.resetsAt);
      if (!Number.isNaN(v) && v < t) t = v;
    }
  }
  return t;
}
function renderGrouped(accounts, now) {
  const ordered = [...accounts].sort((a, b) =>
    ((PROVIDER_ORDER[a.provider] ?? 9) - (PROVIDER_ORDER[b.provider] ?? 9))
    || (nearestWeeklyReset(a) - nearestWeeklyReset(b))
    || String(a.label).localeCompare(String(b.label)));
  let html = '', group = null;
  for (const u of ordered) {
    if (u.provider !== group) { group = u.provider; html += `<h2 class="group ${group}">${group}</h2>`; }
    html += card(u, now);
  }
  return html;
}

function tightest(accounts) {
  let worst = null;
  for (const u of accounts) {
    const sessionKind = u.provider === 'grok' ? '2h · grok-4' : 'session';
    for (const [kind, w] of [[sessionKind, u.session], ['weekly', u.weekly], ['weekly · opus', u.weeklyOpus], ['weekly · fable', u.fable]]) {
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
    // Merge over the defaults rather than replace: an older still-running server may serve a
    // pollIntervalSeconds without newer provider keys, which must not degrade stale detection.
    if (data.pollIntervalSeconds) pollSecs = { ...pollSecs, ...data.pollIntervalSeconds };
    const now = Date.now();
    cardsEl.innerHTML = renderGrouped(data.accounts, now);
    summaryEl.textContent = tightest(data.accounts);
    updatedEl.textContent = `updated ${new Date(now).toLocaleTimeString()}`;
  } catch {
    updatedEl.textContent = 'connection lost — retrying';
  }
}

refresh();
setInterval(refresh, refreshMs);
