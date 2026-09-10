import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeClaudeUsage, fetchClaudeUsage } from '../../src/adapters/claude.ts';
import { StaleCredentialsError } from '../../src/auth/claude.ts';
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

test('normalizeClaudeUsage extracts the Fable weekly-scoped bucket from limits[]', async () => {
  const u = normalizeClaudeUsage(await fixture(), ACC, NOW);
  assert.equal(u.fable?.utilization, 88);
  assert.equal(u.fable?.resetsAt, '2026-07-02T09:00:00.000Z');
  assert.equal(u.fableAccess, true);
});

test('normalizeClaudeUsage reports fableAccess=true even at 0% (access shown, not hidden)', () => {
  const body = { limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: null,
      scope: { model: { display_name: 'Fable' } }, is_active: false },
  ] };
  const u = normalizeClaudeUsage(body, ACC, NOW);
  assert.equal(u.fableAccess, true);
  assert.equal(u.fable?.utilization, 0);
});

test('normalizeClaudeUsage reports fableAccess=false when the account has no Fable-scoped limit', () => {
  const body = { five_hour: { utilization: 1, resets_at: null }, limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 10, resets_at: null, scope: null, is_active: true },
  ] };
  const u = normalizeClaudeUsage(body, ACC, NOW);
  assert.equal(u.fableAccess, false);
  assert.equal(u.fable, null);
  // no limits array at all → also no access
  assert.equal(normalizeClaudeUsage({}, ACC, NOW).fableAccess, false);
});

test('normalizeClaudeUsage matches Fable by scope.model.display_name regardless of order/kind', () => {
  // Real shape: top-level seven_day_* are null; Fable lives only in limits[]. Match must not depend
  // on the entry being first or on its `kind` string.
  const body = {
    five_hour: { utilization: 5, resets_at: '2026-07-08T00:00:00Z' },
    seven_day: { utilization: 63, resets_at: '2026-07-08T20:00:00Z' },
    seven_day_opus: null,
    limits: [
      { kind: 'weekly_scoped', group: 'weekly', percent: 97, resets_at: '2026-07-08T20:59:59Z',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 63, resets_at: '2026-07-08T20:00:00Z', scope: null, is_active: false },
    ],
  };
  const u = normalizeClaudeUsage(body, ACC, NOW);
  assert.equal(u.weeklyOpus, null);
  assert.equal(u.fable?.utilization, 97);
  assert.equal(u.fable?.resetsAt, '2026-07-08T20:59:59.000Z');
  assert.equal(u.fableAccess, true);
});

test('normalizeClaudeUsage leaves fable null when no Fable-scoped limit is present', () => {
  const noFable = { five_hour: { utilization: 1, resets_at: null }, limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 10, resets_at: null, scope: null, is_active: true },
  ] };
  assert.equal(normalizeClaudeUsage(noFable, ACC, NOW).fable, null);
  // no limits array at all
  assert.equal(normalizeClaudeUsage({ five_hour: { utilization: 1, resets_at: null } }, ACC, NOW).fable, null);
});

test('normalizeClaudeUsage keeps fable resets_at null (freshly-reset scoped window)', () => {
  const body = { limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: null,
      scope: { model: { display_name: 'Fable' } }, is_active: false },
  ] };
  const u = normalizeClaudeUsage(body, ACC, NOW);
  assert.equal(u.fable?.utilization, 0);
  assert.equal(u.fable?.resetsAt, null);
});

test('normalizeClaudeUsage tolerates missing windows', () => {
  const u = normalizeClaudeUsage({}, ACC, NOW);
  assert.equal(u.session, null);
  assert.equal(u.weekly, null);
  assert.equal(u.weeklyOpus, null);
  assert.equal(u.fable, null);
  assert.equal(u.fableAccess, false);
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

test('fetchClaudeUsage maps StaleCredentialsError to status=stale without any network call', async () => {
  let calls = 0;
  const getAccessToken = async () => { throw new StaleCredentialsError('Claude credentials stale (expired 2026-07-08T00:00:00.000Z) — open a Claude Code session for this account to refresh them'); };
  const fetchImpl = (async () => { calls += 1; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  const u = await fetchClaudeUsage(ACC, { getAccessToken, fetchImpl }, NOW);
  assert.equal(u.status, 'stale');
  assert.match(u.error ?? '', /stale/i);
  assert.equal(calls, 0);
});

test('fetchClaudeUsage points 401/403 at the credential source for read-only accounts (not add-account)', async () => {
  const roAcc: AccountConfig = { ...ACC, credentialsMode: 'readonly' };
  const fetchImpl = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
  const u = await fetchClaudeUsage(roAcc, { getAccessToken: async () => 'tok', fetchImpl }, NOW);
  assert.equal(u.status, 'auth_error');
  assert.match(u.error ?? '', /read-only|source/i);
  assert.doesNotMatch(u.error ?? '', /add-account/);
});

// A rate-limited account is told when to come back; the card and the poller both need that
// instant, or the dashboard promises "retry in 3m" for a door that stays shut for half an hour.
test('fetchClaudeUsage carries the 429 Retry-After through as retryAt', async () => {
  const fetchImpl = (async () => new Response('slow down', { status: 429, headers: { 'retry-after': '1961' } })) as unknown as typeof fetch;
  const u = await fetchClaudeUsage(ACC, { getAccessToken: async () => 'tok', fetchImpl }, NOW);
  assert.equal(u.status, 'throttled');
  assert.equal(u.retryAt, new Date(NOW.getTime() + 1_961_000).toISOString());
});

test('fetchClaudeUsage leaves retryAt null when the 429 carries no Retry-After', async () => {
  const fetchImpl = (async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch;
  const u = await fetchClaudeUsage(ACC, { getAccessToken: async () => 'tok', fetchImpl }, NOW);
  assert.equal(u.retryAt, null);
});
