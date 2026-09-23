// Care marks and window jumping, shared by the Windows tab and the per-session breakdown on the
// Usage page. The same four buttons mean the same thing on both surfaces, and both write the one
// file (`~/.claude/idle-handover/window-modes.json`) that the external watchdogs obey.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const MODES = [
  ['auto', 'auto', 'General rule: warmed while you worked here recently, compacted after an hour idle.'],
  ['warm', 'warm', 'Keep the cache warm, never compact.'],
  ['off', 'off', 'Leave this window completely alone — no warming, no compaction.'],
  ['ever', 'ever', 'Forever window: always warm, and cleared with a handover once the context fills up.'],
];

/** `w` needs a paneId, a cwd and the current mode (`null` means no mark, i.e. auto). */
export function modeButtons(w) {
  const current = w.mode ?? 'auto';
  return MODES.map(([mode, text, title]) => {
    const on = mode === current ? ' on' : '';
    return `<button class="fl-mode${on}" data-pane="${esc(w.paneId)}" data-cwd="${esc(w.cwd)}" data-mode="${mode}" title="${esc(title)}">${esc(text)}</button>`;
  }).join('');
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
