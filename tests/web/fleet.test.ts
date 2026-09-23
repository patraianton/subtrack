import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatIdle, renderFleet } from '../../web/fleet.js';

const data = {
  idleWindowMinutes: { min: 55, max: 1440 },
  generatedAt: '2026-09-23T10:00:00.000Z',
  warnings: [],
  windows: [
    {
      paneId: 'w85:p1', workspaceId: 'w85', folder: 'news', cwd: 'C:\\Users\\<user>\\projects\\news',
      title: 'News digest', agentStatus: 'idle', sessionId: 'sid-news', lastActivity: '2026-09-23T06:00:00.000Z',
      idleMinutes: 240, accountId: 'cc7', accountLabel: 'cc7', mode: null, markScope: null, markedAt: null,
      lastCompactAt: '2026-09-23T10:11:02', lastCompactFailed: false, compactable: true, reason: 'due on the next round',
      workspaceLabel: 'news digest', workspaceNumber: 4, repoName: 'news', isWorktree: false, depth: 0, branch: 'main',
    },
    {
      paneId: 'w3H:p1', workspaceId: 'w3H', folder: 'ai-aoutbound', cwd: 'C:\\Users\\<user>\\projects\\ai',
      title: '<script>', agentStatus: 'working', sessionId: 'sid-ai', lastActivity: '2026-09-23T09:45:00.000Z',
      idleMinutes: 15, accountId: 'cc5', accountLabel: 'cc5', mode: 'off' as const, markScope: 'pane' as const,
      markedAt: '2026-09-01 10:46', lastCompactAt: null, lastCompactFailed: false, compactable: false, reason: 'marked off — never touched',
      workspaceLabel: 'ai-aoutbound', workspaceNumber: 31, repoName: 'team-ops', isWorktree: true, depth: 1, branch: 'feat/2385',
    },
  ],
};

test('formatIdle stays readable from minutes to days', () => {
  assert.equal(formatIdle(0), '0m');
  assert.equal(formatIdle(45), '45m');
  assert.equal(formatIdle(125), '2h 05m');
  assert.equal(formatIdle(2000), '1d 9h');
  assert.equal(formatIdle(null), '—');
});

test('renderFleet shows one row per window with its pane, idle time and reason', () => {
  const html = renderFleet(data);
  assert.match(html, /2 Claude windows/);
  assert.match(html, /w85:p1/);
  assert.match(html, /4h 00m/);
  assert.match(html, /due on the next round/);
  assert.match(html, /1 marked off/);
});

test('renderFleet marks the current mode button and defaults to auto', () => {
  const html = renderFleet(data);
  const rows = html.split('class="fl-row');
  const news = rows.find((r) => r.includes('w85:p1'))!;
  const ai = rows.find((r) => r.includes('w3H:p1'))!;
  assert.match(news, /data-mode="auto" title="[^"]*">auto/);
  assert.match(news, /class="fl-mode on"[^>]*data-mode="auto"/);
  assert.match(ai, /class="fl-mode on"[^>]*data-mode="off"/);
  assert.match(ai, /marked off \(|marked off ·/);
});

// The page is read next to the herdr sidebar, so it draws the same shape: herdr's name for the
// window, its branch underneath, and worktrees nested under the repo they belong to.
test('a worktree row is nested, tagged and shows its branch', () => {
  const html = renderFleet(data);
  const rows = html.split('class="fl-row');
  const repo = rows.find((r) => r.includes('w85:p1'))!;
  const worktree = rows.find((r) => r.includes('w3H:p1'))!;

  assert.match(repo, /go root/);
  assert.match(repo, /--d:0/);
  assert.match(repo, /fl-folder">news digest/, "herdr's own name for the window, not the folder");
  assert.match(repo, /fl-branch">main</);
  assert.doesNotMatch(repo, /fl-wt/);

  assert.match(worktree, /go nested/);
  assert.match(worktree, /--d:1/);
  assert.match(worktree, /fl-tree">└/);
  assert.match(worktree, /fl-wt[^>]*>worktree · team-ops</);
  assert.match(worktree, /fl-branch">feat\/2385</);
});

test('every row carries the pane it opens, and the header row does not', () => {
  const html = renderFleet(data);
  assert.match(html, /class="fl-row go[^"]*"[^>]*data-focus="w85:p1"/);
  assert.match(html, /data-focus="w3H:p1"/);
  const head = html.split('class="fl-row').find((r) => r.includes('fl-head'))!;
  assert.doesNotMatch(head, /data-focus/);
});

// Four one-word buttons are unreadable without a key, and a tooltip only helps someone who
// already suspects there is one.
test('the page explains what each mark means and what a row click does', () => {
  const html = renderFleet(data);
  for (const mode of ['auto', 'warm', 'off', 'ever']) {
    assert.match(html, new RegExp(`<b>${mode}</b>`), `no legend entry for ${mode}`);
  }
  assert.match(html, /never compact/);
  assert.match(html, /click a row to open that window in herdr/);
  assert.match(html, /never compacts, warms or types/);
});

test('renderFleet escapes window titles and reports an empty fleet', () => {
  assert.ok(!renderFleet(data).includes('<script>'));
  const empty = renderFleet({ ...data, windows: [], warnings: ['herdr returned no panes'] });
  assert.match(empty, /herdr returned no panes/);
  assert.match(empty, /No Claude windows/);
});
