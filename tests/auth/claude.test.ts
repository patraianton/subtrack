import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAuth, claudeHomeDir, claudeCredentialsPath, buildClaudeLogin, readClaudeOauth } from '../../src/auth/claude.ts';

async function withHome(fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'claude-home-'));
  try { await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}
async function writeCreds(home: string, oauth: Record<string, unknown>) {
  await writeFile(claudeCredentialsPath(home), JSON.stringify({ claudeAiOauth: oauth }), 'utf8');
}

test('claudeHomeDir / claudeCredentialsPath / buildClaudeLogin', () => {
  assert.equal(claudeHomeDir('/base', 'c1'), join('/base', 'claude-homes', 'c1'));
  assert.equal(claudeCredentialsPath('/h'), join('/h', '.credentials.json'));
  const spec = buildClaudeLogin('/h');
  assert.equal(spec.cmd, 'claude');
  assert.equal(spec.env.CLAUDE_CONFIG_DIR, '/h');
});

test('readClaudeOauth returns the oauth object, or undefined when absent', async () => {
  await withHome(async (home) => {
    assert.equal(await readClaudeOauth(home), undefined);
    await writeCreds(home, { accessToken: 'AT' });
    assert.equal((await readClaudeOauth(home))?.accessToken, 'AT');
  });
});

test('getAccessToken returns cached token when not near expiry (no refresh)', async () => {
  await withHome(async (home) => {
    const clock = 1_000_000;
    await writeCreds(home, { accessToken: 'live', refreshToken: 'r', expiresAt: clock + 10 * 60_000 });
    const fetchImpl = (async () => { throw new Error('should not refresh'); }) as unknown as typeof fetch;
    const auth = new ClaudeAuth(fetchImpl, () => clock);
    assert.equal(await auth.getAccessToken(home), 'live');
  });
});

test('getAccessToken refreshes (form-urlencoded) and persists the rotated token back to the home', async () => {
  await withHome(async (home) => {
    const clock = 1_000_000;
    await writeCreds(home, { accessToken: 'old', refreshToken: 'r-old', expiresAt: clock - 1, email: 'x@y.z' });
    let seenContentType: string | undefined;
    let seenBody = '';
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenContentType = new Headers(init?.headers).get('content-type') ?? undefined;
      seenBody = String(init?.body);
      return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r-new', expires_in: 28800, scope: 'user:profile' }), { status: 200 });
    }) as unknown as typeof fetch;
    const auth = new ClaudeAuth(fetchImpl, () => clock);

    assert.equal(await auth.getAccessToken(home), 'new');
    assert.equal(seenContentType, 'application/x-www-form-urlencoded'); // NOT application/json
    const params = new URLSearchParams(seenBody);
    assert.equal(params.get('grant_type'), 'refresh_token');
    assert.equal(params.get('refresh_token'), 'r-old');

    const persisted = await readClaudeOauth(home);
    assert.equal(persisted?.accessToken, 'new');
    assert.equal(persisted?.refreshToken, 'r-new');
    assert.equal(persisted?.expiresAt, clock + 28800 * 1000);
    const file = JSON.parse(await readFile(claudeCredentialsPath(home), 'utf8')) as { claudeAiOauth: { email?: string } };
    assert.equal(file.claudeAiOauth.email, 'x@y.z'); // unrelated fields preserved
  });
});

test('getAccessToken force refresh ignores a still-valid cache', async () => {
  await withHome(async (home) => {
    const clock = 1_000_000;
    await writeCreds(home, { accessToken: 'live', refreshToken: 'r', expiresAt: clock + 10 * 60_000 });
    const fetchImpl = (async () => new Response(JSON.stringify({ access_token: 'forced', expires_in: 28800 }), { status: 200 })) as unknown as typeof fetch;
    const auth = new ClaudeAuth(fetchImpl, () => clock);
    assert.equal(await auth.getAccessToken(home, { force: true }), 'forced');
  });
});

test('getAccessToken returns the stale token when expired but there is no refresh token', async () => {
  await withHome(async (home) => {
    const clock = 1_000_000;
    await writeCreds(home, { accessToken: 'stale', expiresAt: clock - 1 }); // no refreshToken
    const fetchImpl = (async () => { throw new Error('should not refresh'); }) as unknown as typeof fetch;
    const auth = new ClaudeAuth(fetchImpl, () => clock);
    assert.equal(await auth.getAccessToken(home), 'stale');
  });
});

test('getAccessToken throws when the credentials file is missing', async () => {
  await withHome(async (home) => {
    const auth = new ClaudeAuth((async () => new Response('')) as unknown as typeof fetch, () => 0);
    await assert.rejects(() => auth.getAccessToken(home), /add-account/);
  });
});

test('refresh failure surfaces an error', async () => {
  await withHome(async (home) => {
    await writeCreds(home, { accessToken: 'old', refreshToken: 'r', expiresAt: 0 });
    const fetchImpl = (async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
    const auth = new ClaudeAuth(fetchImpl, () => 1);
    await assert.rejects(() => auth.getAccessToken(home), /refresh failed/i);
  });
});
