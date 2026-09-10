import { formatCountdown } from '/format.js';
import { burnSupported, renderBurn } from '/burn.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cardsEl = document.getElementById('cards');
const summaryEl = document.getElementById('summary');
const updatedEl = document.getElementById('updated');
let refreshMs = 30000;
let pollSecs = { claude: 180, codex: 60, grok: 60 };

function gauge(name, w, now, opts = {}) {
  // A Claude or Codex session bar is clickable: it opens the local per-session breakdown of that
  // window. Grok keeps no local session store, so its bar stays inert.
  const open = opts.account && expanded.has(opts.account);
  const attrs = opts.account ? ` class="gauge clickable${open ? ' open' : ''}" data-burn="${esc(opts.account)}" role="button" tabindex="0"` : ' class="gauge"';
  const caret = opts.account ? `<span class="caret">${open ? '▾' : '▸'}</span>` : '';
  if (!w) return `<div${attrs}><div class="gauge-top"><span>${name}${caret}</span><span>—</span></div><div class="bar"></div></div>`;
  const pct = Math.round(w.utilization);
  return `<div${attrs}><div class="gauge-top"><span>${name} · ${pct}%${caret}</span><span>resets ${formatCountdown(w.resetsAt, now)}</span></div>`
    + `<div class="bar"><div class="fill ${w.severity}" style="width:${Math.min(pct, 100)}%"></div></div></div>`;
}

// --- who burned this window -------------------------------------------------------------------
// Shares come from local Claude transcripts and Codex rollouts, not from the provider: it publishes
// one percentage per window and never says which session produced it. Rendering lives in burn.js so
// it stays testable.
const expanded = new Set();
const burn = new Map(); // accountId -> { loading } | { error } | { data }

function burnBlock(u, now) {
  if (!burnSupported(u.provider) || !expanded.has(u.accountId)) return '';
  return renderBurn(burn.get(u.accountId), now);
}

async function loadBurn(accountId) {
  burn.set(accountId, { loading: true });
  try {
    const res = await fetch(`/api/burn?account=${encodeURIComponent(accountId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    burn.set(accountId, { data });
  } catch (e) {
    burn.set(accountId, { error: `breakdown unavailable: ${e.message}` });
  }
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
  // A throttled card is waiting, not broken: the numbers above it are the last real ones and the
  // provider told us when it will answer again. Crit red is for a card that needs a hand (auth).
  const noteClass = u.status === 'throttled' ? 'err wait' : 'err';
  const note = notes.length ? `<div class="${noteClass}">${esc(notes.join(' · '))}</div>` : '';
  const ts = u.lastUpdated ? `<span class="cardts">${new Date(u.lastUpdated).toLocaleTimeString()}</span>` : '';
  const stale = isStale(u, now) ? ' stale' : '';
  // Grok's tracked window is the per-model 2-hour allowance, not a 5h session; label it honestly,
  // and hide the weekly row until Grok's weekly endpoint is wired (no permanently-dashed bar).
  const sessionName = u.provider === 'grok' ? '2h · grok-4' : 'session';
  const weekly = (u.provider === 'grok' && !u.weekly) ? '' : gauge('weekly', u.weekly, now);
  const sessionGauge = gauge(sessionName, u.session, now, burnSupported(u.provider) ? { account: u.accountId } : {});
  return `<section class="card ${u.provider} ${u.status}${stale}">`
    + `<div class="card-head"><span class="badge ${u.provider}">${u.provider}</span><span class="label">${esc(u.label)}</span>${ts}<span class="dot ${u.status}"></span></div>`
    + sessionGauge + burnBlock(u, now) + weekly + opus + fable + note + `</section>`;
}

// Group cards by provider (Claude first, then Codex). Within each group the soonest weekly-class
// reset comes first (Anton 2026-08-08: "which ones can I work with" — nearest reset on top); accounts
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

let accountsSnapshot = [];

function render() {
  const now = Date.now();
  cardsEl.innerHTML = renderGrouped(accountsSnapshot, now);
  summaryEl.textContent = tightest(accountsSnapshot);
}

async function toggleBurn(accountId) {
  if (expanded.has(accountId)) { expanded.delete(accountId); render(); return; }
  expanded.add(accountId);
  render();                       // show the "reading…" placeholder immediately
  await loadBurn(accountId);
  render();
}

cardsEl.addEventListener('click', (event) => {
  const target = event.target.closest('[data-burn]');
  if (target) void toggleBurn(target.dataset.burn);
});
cardsEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target.closest('[data-burn]');
  if (!target) return;
  event.preventDefault();
  void toggleBurn(target.dataset.burn);
});

async function refresh() {
  try {
    const res = await fetch('/api/usage');
    const data = await res.json();
    refreshMs = (data.uiRefreshSeconds || 30) * 1000;
    // Merge over the defaults rather than replace: an older still-running server may serve a
    // pollIntervalSeconds without newer provider keys, which must not degrade stale detection.
    if (data.pollIntervalSeconds) pollSecs = { ...pollSecs, ...data.pollIntervalSeconds };
    accountsSnapshot = data.accounts;
    render();
    updatedEl.textContent = `updated ${new Date().toLocaleTimeString()}`;
    // Keep any open breakdown live too; the server caches it, so this is cheap.
    if (expanded.size) {
      await Promise.all([...expanded].map((accountId) => loadBurn(accountId)));
      render();
    }
  } catch {
    updatedEl.textContent = 'connection lost — retrying';
  }
}

refresh();
setInterval(refresh, refreshMs);
