import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeCodexUsage, fetchCodexUsage } from '../../src/adapters/codex.ts';
import type { AccountConfig } from '../../src/types.ts';

const ACC: AccountConfig = { id: 'x1', label: 'Codex 1', provider: 'codex', enabled: true, credentialsHome: '/home/x1' };
const NOW = new Date('2026-06-29T12:00:00.000Z');

async function fixture() {
  const p = fileURLToPath(new URL('../fixtures/codex-usage.json', import.meta.url));
  return JSON.parse(await readFile(p, 'utf8'));
}

test('normalizeCodexUsage maps primary_window->session, secondary_window->weekly by limit_window_seconds', async () => {
  const u = normalizeCodexUsage(await fixture(), ACC, NOW);
  assert.equal(u.session?.utilization, 18);
  assert.equal(u.weekly?.utilization, 33);
  assert.equal(u.session?.resetsAt, new Date(1782744000 * 1000).toISOString());
  assert.equal(u.weeklyOpus, null);
  assert.equal(u.status, 'ok');
});

test('normalizeCodexUsage maps windows by limit_window_seconds regardless of slot ordering', () => {
  const swapped = {
    rate_limit: {
      primary_window:   { limit_window_seconds: 604800, used_percent: 33, reset_at: 1783200000 },
      secondary_window: { limit_window_seconds: 18000,  used_percent: 18, reset_at: 1782744000 },
    },
  };
  const u = normalizeCodexUsage(swapped, ACC, NOW);
  assert.equal(u.session?.utilization, 18);
  assert.equal(u.weekly?.utilization, 33);
});

test('fetchCodexUsage sends Bearer + chatgpt-account-id and normalizes', async () => {
  const body = await fixture();
  let seen: Headers | undefined;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const deps = { readAuth: async () => ({ accessToken: 'AT', accountId: 'acct_9' }), fetchImpl };
  const u = await fetchCodexUsage(ACC, deps, NOW);
  assert.equal(u.session?.utilization, 18);
  assert.equal(seen?.get('authorization'), 'Bearer AT');
  assert.equal(seen?.get('chatgpt-account-id'), 'acct_9');
});

test('fetchCodexUsage maps 401 to auth_error', async () => {
  const fetchImpl = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
  const deps = { readAuth: async () => ({ accessToken: 'AT', accountId: 'a' }), fetchImpl };
  const u = await fetchCodexUsage(ACC, deps, NOW);
  assert.equal(u.status, 'auth_error');
  assert.match(u.error ?? '', /codex login/i);
});

test('fetchCodexUsage routes readonly 401 recovery to the external Hermes owner', async () => {
  const fetchImpl = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
  let externalOwner = false;
  const deps = { readAuth: async (_home: string, opts?: { externalOwner?: boolean }) => { externalOwner = opts?.externalOwner === true; return { accessToken: 'AT', accountId: 'a' }; }, fetchImpl };
  const usage = await fetchCodexUsage({ ...ACC, credentialsMode: 'readonly' }, deps, NOW);
  assert.equal(externalOwner, true);
  assert.equal(usage.status, 'auth_error');
  assert.match(usage.error ?? '', /owning Hermes/i);
  assert.doesNotMatch(usage.error ?? '', /CODEX_HOME|codex login \(/i);
});

test('fetchCodexUsage maps credential read failures to auth_error without a network call', async () => {
  let fetched = false;
  const deps = {
    readAuth: async () => { throw new Error('Codex login missing — run: codex login'); },
    fetchImpl: (async () => { fetched = true; return new Response('{}'); }) as unknown as typeof fetch,
  };

  const usage = await fetchCodexUsage(ACC, deps, NOW);

  assert.equal(usage.status, 'auth_error');
  assert.match(usage.error ?? '', /codex login/i);
  assert.equal(fetched, false);
});

test('normalizeCodexUsage flags an unexpected 200 body as error', () => {
  const u = normalizeCodexUsage({ something: 'unexpected' }, ACC, NOW);
  assert.equal(u.status, 'error');
  assert.match(u.error ?? '', /unexpected/i);
});
