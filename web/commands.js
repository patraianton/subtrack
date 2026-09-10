// Cheat sheet for the commands you type around the panel: what to type and what it does. The page
// is static and hand-written — the subtrack CLI group mirrors src/cli.ts; add your own groups below.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const GROUPS = [
  {
    title: 'The subtrack panel itself',
    note: 'The account list is read once at startup: edit the accounts, then restart the panel.',
    items: [
      { cmd: 'npm start', desc: 'Start the panel on 127.0.0.1:7777 and open the browser' },
      { cmd: 'npx tsx src/cli.ts serve --no-open', desc: 'Same, without opening the browser' },
      { cmd: 'npx tsx src/cli.ts status', desc: 'Is the panel daemon alive' },
      { cmd: 'npx tsx src/cli.ts start', desc: 'Start the panel daemon' },
      { cmd: 'npx tsx src/cli.ts stop', desc: 'Stop the panel daemon' },
      { cmd: 'npx tsx src/cli.ts logs --lines 80', desc: 'Last 80 log lines' },
      { cmd: 'npx tsx src/cli.ts install', desc: 'Add the at-logon autostart' },
      { cmd: 'npx tsx src/cli.ts uninstall', desc: 'Remove the autostart' },
      { cmd: 'npx tsx src/cli.ts list', desc: 'List the account cards' },
      { cmd: 'npx tsx src/cli.ts add-account <id> --provider claude --label "Name"', desc: 'Add a card. The provider is claude, codex or grok.' },
      { cmd: 'npx tsx src/cli.ts rename <id> "New name"', desc: 'Rename a card' },
      { cmd: 'npx tsx src/cli.ts remove-account <id>', desc: 'Remove a card' },
      { cmd: 'npx tsx src/cli.ts check', desc: 'Check the config and logins' },
      { cmd: 'npm test', desc: 'Run the whole test suite' },
      { cmd: 'npm run typecheck', desc: 'Type-check' },
    ],
  },
  {
    title: 'Your own commands',
    note: 'Add groups to GROUPS in web/commands.js — for example the shell functions you use to start each subscription. The page is static: nothing here leaves your machine, and the tests only check the shape.',
    items: [
      { cmd: 'cc3', desc: 'Example: a PowerShell function that sets CLAUDE_CONFIG_DIR to your third Claude home and starts Claude Code there' },
      { cmd: 'cx2', desc: 'Example: a function that sets CODEX_HOME to your second Codex home and starts Codex there' },
      { cmd: 'cclast 3', desc: 'Example: continue the newest session of this folder under subscription 3 when the 5-hour limit hits' },
    ],
  },
];

const listEl = document.getElementById('cmd-list');
const countEl = document.getElementById('cmd-count');
const searchEl = document.getElementById('cmd-search');
const quizEl = document.getElementById('cmd-quiz');

const TOTAL = GROUPS.reduce((n, g) => n + g.items.length, 0);

function matches(item, group, needle) {
  if (!needle) return true;
  return (item.cmd + ' ' + item.desc + ' ' + group.title).toLowerCase().includes(needle);
}

function render() {
  const needle = searchEl.value.trim().toLowerCase();
  let shown = 0;
  const html = GROUPS.map((g) => {
    const items = g.items.filter((it) => matches(it, g, needle));
    if (!items.length) return '';
    shown += items.length;
    const note = g.note ? `<p class="cmd-note">${esc(g.note)}</p>` : '';
    const rows = items.map((it) => `<button type="button" class="cmd-row" data-cmd="${esc(it.cmd)}">`
      + `<code class="cmd-name">${esc(it.cmd)}</code>`
      + `<span class="cmd-desc">${esc(it.desc)}</span>`
      + `<span class="cmd-copy">copy</span></button>`).join('');
    return `<section class="cmd-group${g.accent ? ' ' + g.accent : ''}"><h2>${esc(g.title)}</h2>${note}<div class="cmd-rows">${rows}</div></section>`;
  }).join('');
  listEl.innerHTML = html || '<p class="empty">Nothing found.</p>';
  countEl.textContent = needle ? `${shown} of ${TOTAL} commands` : `${TOTAL} commands`;
}

// Clicking a row copies the command. Typing it by hand is better for memory, but when it has
// to be quick, let it copy.
listEl.addEventListener('click', async (e) => {
  const row = e.target.closest('.cmd-row');
  if (!row) return;
  const mark = row.querySelector('.cmd-copy');
  try {
    await navigator.clipboard.writeText(row.dataset.cmd);
    mark.textContent = 'copied';
  } catch {
    mark.textContent = 'failed';
  }
  setTimeout(() => { mark.textContent = 'copy'; }, 1500);
});

searchEl.addEventListener('input', render);

// "Quiz me": explanations are blurred, only the commands stay readable. Hovering a row reveals
// that one row. This is the memory drill the tab exists for.
quizEl.addEventListener('change', () => {
  document.body.classList.toggle('cmd-quizmode', quizEl.checked);
});

// "/" focuses the search box, Escape clears it.
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== searchEl) { e.preventDefault(); searchEl.focus(); searchEl.select(); }
  if (e.key === 'Escape' && document.activeElement === searchEl) { searchEl.value = ''; render(); searchEl.blur(); }
});

render();
