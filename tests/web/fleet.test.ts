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
    },
    {
      paneId: 'w3H:p1', workspaceId: 'w3H', folder: 'ai-aoutbound', cwd: 'C:\\Users\\<user>\\projects\\ai',
      title: '<script>', agentStatus: 'working', sessionId: 'sid-ai', lastActivity: '2026-09-23T09:45:00.000Z',
      idleMinutes: 15, accountId: 'cc5', accountLabel: 'cc5', mode: 'off' as const, markScope: 'pane' as const,
      markedAt: '2026-09-01 10:46', lastCompactAt: null, lastCompactFailed: false, compactable: false, reason: 'marked off — never touched',
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

test('every row carries the pane it opens, and the header row does not', () => {
  const html = renderFleet(data);
  assert.match(html, /class="fl-row go[^"]*" data-focus="w85:p1"/);
  assert.match(html, /data-focus="w3H:p1"/);
  const head = html.split('class="fl-row').find((r) => r.includes('fl-head'))!;
  assert.doesNotMatch(head, /data-focus/);
});

test('renderFleet escapes window titles and reports an empty fleet', () => {
  assert.ok(!renderFleet(data).includes('<script>'));
  const empty = renderFleet({ ...data, windows: [], warnings: ['herdr returned no panes'] });
  assert.match(empty, /herdr returned no panes/);
  assert.match(empty, /No Claude windows/);
});
