import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeClaudeUsage, fetchClaudeUsage } from '../../src/adapters/claude.ts';
import type { AccountConfig } from '../../src/types.ts';

const ACC: AccountConfig = { id: 'c1', label: 'Claude 1', provider: 'claude', enabled: true, credentialsHome: '/home/c1' };
const NOW = new Date('2026-06-29T12:00:00.000Z');

async function fixture() {
  const p = fileURLToPath(new URL('../fixtures/claude-usage.json', import.meta.url));
  return JSON.parse(await readFile(p, 'utf8'));
}

test('normalizeClaudeUsage maps five_hour/seven_day/opus', async () => {
  const u = normalizeClaudeUsage(await fixture(), ACC, NOW);
  assert.equal(u.session?.utilization, 62);
  assert.equal(u.weekly?.utilization, 41);
  assert.equal(u.weeklyOpus?.utilization, 55);
  assert.equal(u.session?.resetsAt, '2026-06-29T17:40:00.000Z');
  assert.equal(u.status, 'ok');
});

test('normalizeClaudeUsage tolerates missing windows', () => {
  const u = normalizeClaudeUsage({}, ACC, NOW);
  assert.equal(u.session, null);
  assert.equal(u.weekly, null);
  assert.equal(u.weeklyOpus, null);
});

test('normalizeClaudeUsage keeps resets_at null (freshly-reset window) instead of faking epoch 0', () => {
  // Real post-Fable-reset shape: the window is present at 0% but resets_at is null.
  const u = normalizeClaudeUsage({ five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 0, resets_at: null } }, ACC, NOW);
  assert.equal(u.session?.utilization, 0);
  assert.equal(u.session?.resetsAt, null);   // not '1970-01-01…' which renders as a bogus "resets now"
  assert.equal(u.weekly?.resetsAt, null);
});

test('fetchClaudeUsage returns normalized data on 200', async () => {
  const body = await fixture();
  const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const u = await fetchClaudeUsage(ACC, { getAccessToken: async () => 'tok', fetchImpl }, NOW);
  assert.equal(u.status, 'ok');
  assert.equal(u.weekly?.utilization, 41);
});

test('fetchClaudeUsage maps 403 to auth_error pointing at setup-token', async () => {
  const fetchImpl = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
  const u = await fetchClaudeUsage(ACC, { getAccessToken: async () => 'tok', fetchImpl }, NOW);
  assert.equal(u.status, 'auth_error');
  assert.match(u.error ?? '', /setup-token/);
});

test('fetchClaudeUsage maps 429 to throttled', async () => {
  const fetchImpl = (async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch;
  const u = await fetchClaudeUsage(ACC, { getAccessToken: async () => 'tok', fetchImpl }, NOW);
  assert.equal(u.status, 'throttled');
});

test('fetchClaudeUsage retries once with forced refresh on 401', async () => {
  let calls = 0;
  const forced: boolean[] = [];
  const fetchImpl = (async () => {
    calls += 1;
    return calls === 1 ? new Response('', { status: 401 }) : new Response(JSON.stringify(await fixture()), { status: 200 });
  }) as unknown as typeof fetch;
  const getAccessToken = async (_id: string, opts?: { force?: boolean }) => { forced.push(!!opts?.force); return 'tok'; };
  const u = await fetchClaudeUsage(ACC, { getAccessToken, fetchImpl }, NOW);
  assert.equal(u.status, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(forced, [false, true]);
});

test('fetchClaudeUsage sends required headers', async () => {
  let seen: Headers | undefined;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  await fetchClaudeUsage(ACC, { getAccessToken: async () => 'tok', fetchImpl }, NOW);
  assert.equal(seen?.get('anthropic-beta'), 'claude-code-20250219,oauth-2025-04-20');
  assert.equal(seen?.get('anthropic-version'), '2023-06-01');
  assert.equal(seen?.get('authorization'), 'Bearer tok');
  assert.equal(seen?.get('content-type'), 'application/json');
});

test('fetchClaudeUsage maps a refresh/credential failure to auth_error (not generic error)', async () => {
  const getAccessToken = async () => { throw new Error('Claude token refresh failed: HTTP 400'); };
  const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  const u = await fetchClaudeUsage(ACC, { getAccessToken, fetchImpl }, NOW);
  assert.equal(u.status, 'auth_error');
});
