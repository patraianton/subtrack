import { test } from 'node:test';
import assert from 'node:assert/strict';
import { burnRow, burnSupported, renderBurn, shortModel, shortPath } from '../../web/burn.js';

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
