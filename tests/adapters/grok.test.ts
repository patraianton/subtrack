import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGrokUsage, fetchGrokUsage, fetchGrokEmail } from '../../src/adapters/grok.ts';
import { makeFetchUsage } from '../../src/adapters/index.ts';
import type { AccountConfig } from '../../src/types.ts';

const ACC: AccountConfig = { id: 'g1', label: 'Grok 1', provider: 'grok', enabled: true, credentialsHome: '/home/g1', credentialsMode: 'readonly' };
const NOW = new Date('2026-08-21T12:00:00.000Z');

async function fixture() {
  const p = fileURLToPath(new URL('../fixtures/grok-rate-limits.json', import.meta.url));
  return JSON.parse(await readFile(p, 'utf8'));
}

test('normalizeGrokUsage maps remaining/total queries to a session utilization percent', async () => {
  const u = normalizeGrokUsage(await fixture(), ACC, NOW);
  assert.equal(u.status, 'ok');
  assert.equal(u.provider, 'grok');
  assert.equal(u.session?.utilization, 30);      // 63 of 90 remaining → 30% used
  assert.equal(u.session?.resetsAt, null);       // API anchors no reset while queries remain
  assert.equal(u.weekly, null);
  assert.equal(u.weeklyOpus, null);
  assert.equal(u.fable, null);
  assert.equal(u.fableAccess, false);
});

test('normalizeGrokUsage anchors resetsAt from waitTimeSeconds when the window is exhausted', () => {
  const u = normalizeGrokUsage({ windowSizeSeconds: 7200, remainingQueries: 0, totalQueries: 90, waitTimeSeconds: 5400 }, ACC, NOW);
  assert.equal(u.session?.utilization, 100);
  assert.equal(u.session?.resetsAt, new Date(NOW.getTime() + 5400 * 1000).toISOString());
});

test('normalizeGrokUsage flags an unexpected 200 body as error', () => {
  const u = normalizeGrokUsage({ something: 'unexpected' }, ACC, NOW);
  assert.equal(u.status, 'error');
  assert.match(u.error ?? '', /unexpected/i);
});

test('fetchGrokUsage POSTs the tracked model with the stored cookie and normalizes', async () => {
  const body = await fixture();
  let seen: Headers | undefined;
  let sent = '';
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    sent = String(init?.body ?? '');
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const deps = { readCookie: async () => 'sso=abc; sso-rw=def', fetchImpl };
  const u = await fetchGrokUsage(ACC, deps, NOW);
  assert.equal(u.session?.utilization, 30);
  assert.equal(seen?.get('cookie'), 'sso=abc; sso-rw=def');
  assert.equal(seen?.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(sent), { requestKind: 'DEFAULT', modelName: 'grok-4' });
});

test('fetchGrokUsage maps 401 to auth_error with re-copy guidance', async () => {
  const fetchImpl = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
  const u = await fetchGrokUsage(ACC, { readCookie: async () => 'sso=x', fetchImpl }, NOW);
  assert.equal(u.status, 'auth_error');
  assert.match(u.error ?? '', /cookie/i);
});

test('fetchGrokUsage maps 429 to throttled', async () => {
  const fetchImpl = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
  const u = await fetchGrokUsage(ACC, { readCookie: async () => 'sso=x', fetchImpl }, NOW);
  assert.equal(u.status, 'throttled');
});

test('fetchGrokUsage maps cookie read failures to auth_error without a network call', async () => {
  let fetched = false;
  const deps = {
    readCookie: async () => { throw new Error('Grok cookie missing — copy it from the browser'); },
    fetchImpl: (async () => { fetched = true; return new Response('{}'); }) as unknown as typeof fetch,
  };
  const u = await fetchGrokUsage(ACC, deps, NOW);
  assert.equal(u.status, 'auth_error');
  assert.match(u.error ?? '', /cookie/i);
  assert.equal(fetched, false);
});

test('fetchGrokEmail returns the account email from get-user, empty string on failure', async () => {
  const ok = (async () => new Response(JSON.stringify({ userId: 'u1', email: 'tools@example.com' }), { status: 200 })) as unknown as typeof fetch;
  assert.equal(await fetchGrokEmail('sso=x', ok), 'tools@example.com');
  const bad = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
  assert.equal(await fetchGrokEmail('sso=x', bad), '');
});

test('makeFetchUsage routes grok accounts through the cookie file without any write path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subtrack-grok-route-'));
  try {
    const home = join(dir, 'grok-homes', 'g1');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'cookie.txt'), 'sso=live', 'utf8');
    let cookieSeen = '';
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      cookieSeen = new Headers(init?.headers).get('cookie') ?? '';
      return new Response(JSON.stringify(await fixture()), { status: 200 });
    }) as unknown as typeof fetch;
    const fetchUsage = makeFetchUsage({ fetchImpl });
    const u = await fetchUsage({ ...ACC, credentialsHome: home });
    assert.equal(u.status, 'ok');
    assert.equal(u.session?.utilization, 30);
    assert.equal(cookieSeen, 'sso=live');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
