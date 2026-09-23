// Care marks and window jumping, shared by the Windows tab and the per-session breakdown on the
// Usage page. The same four buttons mean the same thing on both surfaces, and both write the one
// file (`~/.claude/idle-handover/window-modes.json`) that the external watchdogs obey.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// One description per mark, used for both the button tooltip and the legend under the rows, so
// the two can never drift apart.
export const MODES = [
  {
    mode: 'auto',
    title: 'General rule: warmed while you worked here recently, compacted after an hour idle.',
    legend: 'no mark — warmed while you work here, compacted after ~1h idle',
  },
  { mode: 'warm', title: 'Keep the cache warm, never compact.', legend: 'keep the cache warm, never compact' },
  { mode: 'off', title: 'Leave this window completely alone — no warming, no compaction.', legend: 'hands off — no warming, no compaction' },
  {
    mode: 'ever',
    title: 'Forever window: always warm, and cleared with a handover once the context fills up.',
    legend: 'forever window — always warm, cleared with a handover when the context fills',
  },
];

/** `w` needs a paneId, a cwd and the current mode (`null` means no mark, i.e. auto). */
export function modeButtons(w) {
  const current = w.mode ?? 'auto';
  return MODES.map(({ mode, title }) => {
    const on = mode === current ? ' on' : '';
    return `<button class="fl-mode${on}" data-pane="${esc(w.paneId)}" data-cwd="${esc(w.cwd)}" data-mode="${mode}" title="${esc(title)}">${esc(mode)}</button>`;
  }).join('');
}

/**
 * What the buttons and the row itself do, spelled out. Four one-word buttons are unreadable
 * without it, and a tooltip only helps someone who already suspects there is one.
 */
export function modeLegend(rowHint = 'click a row to open that window in herdr') {
  const marks = MODES.map(({ mode, legend }) => `<span class="lg-mark"><b>${esc(mode)}</b> ${esc(legend)}</span>`).join('');
  return `<div class="mode-legend"><span class="lg-hint">${esc(rowHint)}</span>${marks}`
    + '<span class="lg-note">the mark only tells the cache warmer and the compaction watchdog how to treat the window;'
    + ' this page never compacts, warms or types into one.</span></div>';
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/** Pin (or with 'auto' remove) the care mark of one window. */
export function setWindowMode({ pane, cwd, mode }) {
  return post('/api/fleet/mode', { pane, cwd, mode });
}

/** Switch herdr to this pane and bring its terminal window to the front. */
export function focusWindow(pane) {
  return post('/api/fleet/focus', { pane });
}
