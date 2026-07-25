const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const activityOrder = { open: 0, recent: 1, idle: 2, archived: 3 };

function text(value, fallback = '—') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function displayTitle(item, fallback) {
  return text(item.title, text(item.project, text(item.folder, fallback)));
}

function providerBadge(provider) {
  const safeProvider = provider === 'codex' ? 'codex' : 'claude';
  return `<span class="badge ${safeProvider}">${safeProvider}</span>`;
}

function copyButton(key, available) {
  if (!available) return '<span class="session-copy-placeholder">not resumable</span>';
  return `<button type="button" class="session-copy" data-copy-key="${key}">Copy resume</button>`;
}

function formatActivity(value, now = Date.now()) {
  const when = Date.parse(String(value ?? ''));
  if (!Number.isFinite(when)) return 'unknown time';
  const delta = Math.max(0, now - when);
  const minutes = Math.floor(delta / 60_000);
  let relative;
  if (minutes < 1) relative = 'just now';
  else if (minutes < 60) relative = `${minutes}m ago`;
  else if (minutes < 1_440) relative = `${Math.floor(minutes / 60)}h ago`;
  else relative = `${Math.floor(minutes / 1_440)}d ago`;
  return `${relative} · ${new Date(when).toLocaleString()}`;
}

function windowBinding(binding) {
  return ['launch', 'likely', 'ambiguous', 'unknown'].includes(binding) ? binding : 'unknown';
}

export function renderLiveWindows(windows, copyCommands = new Map()) {
  if (!Array.isArray(windows) || windows.length === 0) {
    return '<p class="empty">No live Claude windows found.</p>';
  }

  return windows.map((windowItem, index) => {
    const key = `window-${index}`;
    const command = text(windowItem.resumeCommand, '');
    if (command) copyCommands.set(key, command);
    const binding = windowBinding(windowItem.binding);
    const sessionId = text(windowItem.sessionId, '');
    const launchId = text(windowItem.launchSessionId, '');
    const shownId = sessionId || launchId;
    const account = text(windowItem.accountLabel, text(windowItem.accountId, 'Unknown account'));
    const launcher = text(windowItem.launcher, 'unknown launcher');
    const project = text(windowItem.project, text(windowItem.folder, 'Unknown project'));
    const cwd = text(windowItem.cwd, 'Unknown folder');
    const title = displayTitle(windowItem, 'Untitled Claude window');
    const pid = Number.isFinite(Number(windowItem.pid)) ? String(Number(windowItem.pid)) : 'unknown';

    return `<article class="session-window">`
      + `<div class="session-window-main">`
      + `<div class="session-title-line"><span class="session-live-dot" aria-label="open"></span>${providerBadge('claude')}<h3>${esc(title)}</h3></div>`
      + `<div class="session-project">${esc(project)}</div>`
      + `<code class="session-cwd">${esc(cwd)}</code>`
      + `</div>`
      + `<div class="session-window-context"><span>${esc(account)}</span><span class="session-separator">·</span><strong>${esc(launcher)}</strong></div>`
      + `<div class="session-window-meta"><span>PID ${esc(pid)}</span><span class="session-binding binding-${binding}">${esc(binding)}</span>${shownId ? `<code class="session-id">${esc(shownId)}</code>` : '<span>session unknown</span>'}</div>`
      + `<div class="session-window-action">${copyButton(key, Boolean(command))}</div>`
      + `</article>`;
  }).join('');
}

export function filterSessions(sessions, filters = {}) {
  const provider = filters.provider || 'all';
  const scope = filters.scope || 'working';
  const query = String(filters.query || '').trim().toLocaleLowerCase();

  return (Array.isArray(sessions) ? sessions : []).filter((session) => {
    if (provider !== 'all' && session.provider !== provider) return false;
    if (scope === 'working' && session.activity !== 'open' && session.activity !== 'recent') return false;
    if (!query) return true;
    const haystack = [
      session.title,
      session.project,
      session.folder,
      session.cwd,
      session.accountId,
      session.accountLabel,
      session.launcher,
      session.id,
      session.branch,
      ...(Array.isArray(session.availableLaunchers) ? session.availableLaunchers : []),
    ].map((value) => String(value ?? '')).join('\n').toLocaleLowerCase();
    return haystack.includes(query);
  }).sort((a, b) => {
    const activityDelta = (activityOrder[a.activity] ?? 9) - (activityOrder[b.activity] ?? 9);
    if (activityDelta !== 0) return activityDelta;
    return Date.parse(String(b.lastActivity ?? '')) - Date.parse(String(a.lastActivity ?? ''));
  });
}

export function renderSessionHistory(sessions, copyCommands = new Map(), now = Date.now()) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return '<p class="empty">No sessions match these filters.</p>';
  }

  return sessions.map((session, index) => {
    const key = `session-${index}`;
    const command = text(session.resumeCommand, '');
    if (command) copyCommands.set(key, command);
    const provider = session.provider === 'codex' ? 'codex' : 'claude';
    const activity = ['open', 'recent', 'idle', 'archived'].includes(session.activity) ? session.activity : 'idle';
    const account = text(session.accountLabel, text(session.accountId, 'Unknown account'));
    const launcher = text(session.launcher, 'unknown launcher');
    const project = text(session.project, text(session.folder, 'Unknown project'));
    const cwd = text(session.cwd, 'Unknown folder');
    const title = displayTitle(session, text(session.id, 'Untitled session'));
    const branch = text(session.branch, '');
    const id = text(session.id, 'unknown');

    return `<article class="session-row provider-${provider}">`
      + `<div class="session-row-status"><span class="session-activity activity-${activity}">${esc(activity)}</span>${providerBadge(provider)}</div>`
      + `<div class="session-row-main"><h3>${esc(title)}</h3><div class="session-project">${esc(project)}${branch ? ` <span class="session-branch">${esc(branch)}</span>` : ''}</div><code class="session-cwd">${esc(cwd)}</code></div>`
      + `<div class="session-row-account"><span>${esc(account)}</span><strong>${esc(launcher)}</strong></div>`
      + `<div class="session-row-activity"><span>${esc(formatActivity(session.lastActivity, now))}</span><code class="session-id">${esc(id)}</code></div>`
      + `<div class="session-row-action">${copyButton(key, Boolean(command))}</div>`
      + `</article>`;
  }).join('');
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard is unavailable');
}

// Browser bootstrap (skipped under node:test, which imports the pure render helpers).
if (typeof document !== 'undefined') {
  const windowsEl = document.getElementById('session-windows');
  const historyEl = document.getElementById('session-history');
  const noticeEl = document.getElementById('sessions-notice');
  const summaryEl = document.getElementById('sessions-summary');
  const updatedEl = document.getElementById('updated');
  const windowCountEl = document.getElementById('window-count');
  const sessionCountEl = document.getElementById('session-count');
  const searchEl = document.getElementById('session-search');
  const providerEl = document.getElementById('session-provider');
  const scopeEl = document.getElementById('session-scope');
  const filtersEl = document.getElementById('sessions-filters');
  const copyCommands = new Map();
  let latest = { windows: [], sessions: [], generatedAt: null, warnings: [], partial: false };
  let refreshing = false;

  function render() {
    copyCommands.clear();
    const visible = filterSessions(latest.sessions, {
      query: searchEl.value,
      provider: providerEl.value,
      scope: scopeEl.value,
    });
    windowsEl.innerHTML = renderLiveWindows(latest.windows, copyCommands);
    historyEl.innerHTML = renderSessionHistory(visible, copyCommands);
    windowCountEl.textContent = `${latest.windows.length} open`;
    sessionCountEl.textContent = `${visible.length} of ${latest.sessions.length}`;
    const working = latest.sessions.filter((session) => session.activity === 'open' || session.activity === 'recent').length;
    summaryEl.textContent = `${latest.windows.length} open windows · ${working} working sessions`;

    const warnings = Array.isArray(latest.warnings) ? latest.warnings : [];
    if (latest.partial || warnings.length) {
      noticeEl.hidden = false;
      noticeEl.textContent = warnings.length
        ? `Partial session snapshot: ${warnings.join(' · ')}`
        : 'Partial session snapshot: one or more local stores could not be read.';
    } else {
      noticeEl.hidden = true;
      noticeEl.textContent = '';
    }
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const response = await fetch('/api/sessions', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      latest = {
        windows: Array.isArray(data.windows) ? data.windows : [],
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
        generatedAt: data.generatedAt || null,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
        partial: Boolean(data.partial),
      };
      render();
      const generatedAt = Date.parse(String(latest.generatedAt ?? ''));
      updatedEl.textContent = `updated ${new Date(Number.isFinite(generatedAt) ? generatedAt : Date.now()).toLocaleTimeString()}`;
    } catch {
      updatedEl.textContent = 'sessions unavailable — retrying';
    } finally {
      refreshing = false;
    }
  }

  filtersEl.addEventListener('input', render);
  filtersEl.addEventListener('change', render);

  async function handleCopy(event) {
    const button = event.target.closest('.session-copy');
    if (!button) return;
    const command = copyCommands.get(button.dataset.copyKey);
    if (!command) return;
    const original = button.textContent;
    try {
      await copyText(command);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    window.setTimeout(() => { button.textContent = original; }, 1500);
  }

  windowsEl.addEventListener('click', handleCopy);
  historyEl.addEventListener('click', handleCopy);
  refresh();
  window.setInterval(refresh, 15_000);
}
