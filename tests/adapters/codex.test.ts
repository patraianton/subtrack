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

test('normalizeCodexUsage maps primary->session, secondary->weekly by window_minutes', async () => {
  const u = normalizeCodexUsage(await fixture(), ACC, NOW);
  assert.equal(u.session?.utilization, 18);
  assert.equal(u.weekly?.utilization, 33);
  assert.equal(u.session?.resetsAt, new Date(1782744000 * 1000).toISOString());
  assert.equal(u.weeklyOpus, null);
  assert.equal(u.status, 'ok');
});

test('normalizeCodexUsage maps windows regardless of primary/secondary ordering', () => {
  const swapped = {
    primary:   { window_minutes: 10080, used_percent: 33, resets_at: 1783200000 },
    secondary: { window_minutes: 300,   used_percent: 18, resets_at: 1782744000 },
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

test('normalizeCodexUsage flags an unexpected 200 body as error', () => {
  const u = normalizeCodexUsage({ something: 'unexpected' }, ACC, NOW);
  assert.equal(u.status, 'error');
  assert.match(u.error ?? '', /unexpected/i);
});
