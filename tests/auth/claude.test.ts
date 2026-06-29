import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAuth, claudeCredKey, buildAuthorizeUrl, exchangeCode } from '../../src/auth/claude.ts';
import { MemorySecretStore } from '../../src/secrets.ts';
import type { ClaudeCreds } from '../../src/auth/claude.ts';

const KEY = claudeCredKey('c1');

async function seed(store: MemorySecretStore, creds: ClaudeCreds) {
  await store.set(KEY, JSON.stringify(creds));
}

test('getAccessToken returns cached token when not near expiry', async () => {
  const store = new MemorySecretStore();
  let clock = 1_000_000;
  await seed(store, { accessToken: 'live', refreshToken: 'r', expiresAt: clock + 10 * 60_000 });
  const fetchImpl = (async () => { throw new Error('should not refresh'); }) as unknown as typeof fetch;
  const auth = new ClaudeAuth(store, fetchImpl, () => clock);
  assert.equal(await auth.getAccessToken('c1'), 'live');
});

test('getAccessToken refreshes when expired and persists rotated creds', async () => {
  const store = new MemorySecretStore();
  let clock = 1_000_000;
  await seed(store, { accessToken: 'old', refreshToken: 'r-old', expiresAt: clock - 1 });
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.grant_type, 'refresh_token');
    assert.equal(body.refresh_token, 'r-old');
    return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r-new', expires_in: 28800, scope: 'user:profile user:inference' }), { status: 200 });
  }) as unknown as typeof fetch;
  const auth = new ClaudeAuth(store, fetchImpl, () => clock);
  assert.equal(await auth.getAccessToken('c1'), 'new');
  const stored = JSON.parse((await store.get(KEY))!) as ClaudeCreds;
  assert.equal(stored.accessToken, 'new');
  assert.equal(stored.refreshToken, 'r-new');
  assert.equal(stored.expiresAt, clock + 28800 * 1000);
});

test('getAccessToken force refresh ignores cache', async () => {
  const store = new MemorySecretStore();
  const clock = 1_000_000;
  await seed(store, { accessToken: 'live', refreshToken: 'r', expiresAt: clock + 10 * 60_000 });
  const fetchImpl = (async () => new Response(JSON.stringify({ access_token: 'forced', expires_in: 28800 }), { status: 200 })) as unknown as typeof fetch;
  const auth = new ClaudeAuth(store, fetchImpl, () => clock);
  assert.equal(await auth.getAccessToken('c1', { force: true }), 'forced');
});

test('getAccessToken throws when no creds stored', async () => {
  const auth = new ClaudeAuth(new MemorySecretStore(), (async () => new Response('')) as unknown as typeof fetch, () => 0);
  await assert.rejects(() => auth.getAccessToken('missing'), /add-account/);
});

test('refresh failure surfaces an error', async () => {
  const store = new MemorySecretStore();
  await seed(store, { accessToken: 'old', refreshToken: 'r', expiresAt: 0 });
  const fetchImpl = (async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
  const auth = new ClaudeAuth(store, fetchImpl, () => 1);
  await assert.rejects(() => auth.getAccessToken('c1'), /refresh failed/i);
});

test('buildAuthorizeUrl includes pkce + client_id + profile scope', () => {
  const url = new URL(buildAuthorizeUrl('CHAL', 'STATE'));
  assert.equal(url.searchParams.get('code_challenge'), 'CHAL');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'STATE');
  assert.match(url.searchParams.get('scope') ?? '', /user:profile/);
  assert.ok(url.searchParams.get('client_id'));
});

test('exchangeCode strips #state suffix and POSTs correct body, returns parsed creds', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 28800, scope: 'user:profile user:inference' }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const creds = await exchangeCode('abc#STATE', 'VERIFIER', { fetchImpl, clock: () => 1000 });

  assert.equal(capturedBody?.grant_type, 'authorization_code');
  assert.equal(capturedBody?.code, 'abc');
  assert.equal(capturedBody?.code_verifier, 'VERIFIER');
  assert.equal(creds.accessToken, 'AT');
  assert.equal(creds.refreshToken, 'RT');
  assert.equal(creds.expiresAt, 1000 + 28800 * 1000);
  assert.deepEqual(creds.scopes, ['user:profile', 'user:inference']);
});

test('exchangeCode throws on non-ok response', async () => {
  const fetchImpl = (async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(() => exchangeCode('xyz', 'V', { fetchImpl, clock: () => 0 }), /code exchange failed/i);
});
