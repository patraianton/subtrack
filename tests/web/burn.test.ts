import { test } from 'node:test';
import assert from 'node:assert/strict';
import { burnRow, burnSupported, paneFor, renderBurn, shortModel, shortPath } from '../../web/burn.js';

const NOW = Date.parse('2026-09-05T11:00:00.000Z');

function session(extra: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    cwd: 'C:\\Users\\<user>\\projects\\acme\\reactivation-agent',
    project: 'reactivation-agent',
    share: 48,
    weight: 1000,
    replies: 98,
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    models: ['claude-opus-5'],
    firstAt: '2026-09-05T09:00:00.000Z',
    lastAt: '2026-09-05T10:59:00.000Z',
    contested: false,
    ...extra,
  };
}

function payload(sessions: unknown[], extra: Record<string, unknown> = {}) {
  return {
    data: {
      accountId: 'claude-4',
      accountLabel: 'cc4 · test',
      windowStart: '2026-09-05T08:00:00.000Z',
      resetsAt: '2026-09-05T13:00:00.000Z',
      windowHours: 5,
      sessions,
      totals: { weight: 0, replies: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      otherSessions: 0,
      generatedAt: '2026-09-05T11:00:00.000Z',
      partial: false,
      warnings: [],
      ...extra,
    },
  };
}

test('a burn row shows the share, folder, model and freshness without leaking markup', () => {
  const html = burnRow(session({ cwd: 'C:\\work\\<script>alert(1)</script>', models: ['claude-fable-5-1'] }), NOW);

  assert.match(html, /48%/);
  assert.match(html, /now/, 'a reply a minute ago reads as live');
  assert.match(burnRow(session({ lastAt: '2026-09-05T10:30:00.000Z' }), NOW), /30m ago/);
  assert.match(html, /fable 5\.1/);
  assert.match(html, /98 replies/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('a contested row is marked, an undisputed one is not', () => {
  assert.match(burnRow(session({ contested: true }), NOW), /burn-flag/);
  assert.doesNotMatch(burnRow(session(), NOW), /burn-flag/);
});

test('renderBurn caps the list, sums the tail, and states that the numbers are an estimate', () => {
  const many = Array.from({ length: 9 }, (_, i) => session({ id: `id-${i}`, share: i === 0 ? 20 : 10 }));
  const html = renderBurn(payload(many, { otherSessions: 3 }), NOW);

  assert.equal((html.match(/burn-row/g) ?? []).length, 7, 'six sessions plus the tail row');
  assert.match(html, /\+3 more sessions/);
  assert.match(html, /30%/, 'the three tail sessions are summed');
  assert.match(html, /estimate from session records/);
  assert.match(html, /3 sessions of other accounts ignored/);
});

test('renderBurn reports loading, errors and an empty window instead of showing a blank box', () => {
  assert.match(renderBurn(undefined, NOW), /reading local transcripts/);
  assert.match(renderBurn({ loading: true }, NOW), /reading local transcripts/);
  assert.match(renderBurn({ error: 'breakdown unavailable: boom' }, NOW), /burn-note err/);
  assert.match(renderBurn(payload([]), NOW), /no local session activity/);
  assert.match(renderBurn(payload([], { warnings: ['No local session history found in C:\\home'] }), NOW), /No local session history/);
});

test('path and model shorteners stay readable', () => {
  assert.equal(shortPath('C:\\Users\\<user>\\.herdr\\worktrees\\autopase.lv\\amp-orbs'), 'autopase.lv\\amp-orbs');
  assert.equal(shortPath(null), 'unknown folder');
  assert.equal(shortModel('claude-opus-5'), 'opus 5');
  assert.equal(shortModel('claude-fable-5-1'), 'fable 5.1');
});

test('the clickable bar and the block underneath agree on which providers have a breakdown', () => {
  // These were two separate provider checks, and they drifted: the Codex bar became clickable while
  // the block stayed Claude-only, so clicking it loaded data and rendered nothing.
  assert.equal(burnSupported('claude'), true);
  assert.equal(burnSupported('codex'), true);
  assert.equal(burnSupported('grok'), false);
});

test('a row from another machine says so, and a local row does not', () => {
  const base = { id: 's', cwd: 'C:\work\alpha', share: 50, weight: 1, replies: 2, inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1, models: ['gpt-6-astra'], firstAt: '2026-09-07T10:00:00.000Z', lastAt: '2026-09-07T10:00:00.000Z', contested: false };
  const now = Date.parse('2026-09-07T10:01:00.000Z');
  assert.match(burnRow({ ...base, host: 'mac' }, now), /burn-host">mac</);
  assert.doesNotMatch(burnRow({ ...base, host: null }, now), /burn-host/);
});

// --- the row as a way into the window ----------------------------------------------------------

function pane(extra: Record<string, unknown> = {}) {
  return {
    paneId: 'w85:p1',
    cwd: 'C:\\Users\\<user>\\projects\\acme\\reactivation-agent',
    sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
    mode: null,
    ...extra,
  };
}

test('paneFor matches a live window by session id, then by a folder only one window occupies', () => {
  const byId = pane({ paneId: 'w10:p1', cwd: 'C:\\somewhere\\else' });
  assert.equal(paneFor([byId], session())?.paneId, 'w10:p1', 'the session id wins over the folder');

  // After /clear the window runs a session the transcript never saw; the folder is the fallback.
  const cleared = pane({ sessionId: 'a-newer-session' });
  assert.equal(paneFor([cleared], session())?.paneId, 'w85:p1');

  // Two windows in one folder (worktrees, split panes): jumping to a guess would be worse.
  const twin = pane({ paneId: 'w86:p1', sessionId: 'another' });
  assert.equal(paneFor([cleared, twin], session()), null);

  assert.equal(paneFor([], session()), null);
  assert.equal(paneFor([pane()], session({ host: 'mac' })), null, 'work on another machine has no window here');
});

test('a row with a live window is clickable and carries the care buttons; one without stays inert', () => {
  const live = burnRow(session(), NOW, pane({ mode: 'off' }));
  assert.match(live, /class="burn-row live"/);
  assert.match(live, /data-pane="w85:p1"/);
  assert.match(live, /click to open this window in herdr/);
  assert.match(live, /class="fl-mode on"[^>]*data-mode="off"/);

  const inert = burnRow(session(), NOW);
  assert.match(inert, /class="burn-row"/);
  assert.doesNotMatch(inert, /data-pane=/);
  assert.doesNotMatch(inert, /fl-mode/);
});

test('the legend appears with the buttons and only with them', () => {
  const withWindow = renderBurn(payload([session()]), NOW, [pane()]);
  assert.match(withWindow, /<b>warm<\/b> keep the cache warm, never compact/);
  assert.match(withWindow, /<b>off<\/b>/);
  assert.match(withWindow, /click a row to open that window in herdr/);

  // No live window means no buttons on any row, so a key to them would only be noise.
  assert.doesNotMatch(renderBurn(payload([session()]), NOW), /mode-legend/);
});

test('renderBurn wires each row to its own window', () => {
  const rows = renderBurn(payload([session({ id: 'one' }), session({ id: 'two', cwd: 'C:\\other' })]), NOW, [
    pane({ paneId: 'w1:p1', sessionId: 'one' }),
    pane({ paneId: 'w2:p1', sessionId: 'two', cwd: 'C:\\other' }),
  ]);
  assert.match(rows, /data-pane="w1:p1"/);
  assert.match(rows, /data-pane="w2:p1"/);
  // With no fleet loaded the breakdown still renders, just without the jump.
  assert.doesNotMatch(renderBurn(payload([session()]), NOW), /data-pane=/);
});
