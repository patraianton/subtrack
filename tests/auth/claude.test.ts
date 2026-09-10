import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAuth, claudeHomeDir, claudeCredentialsPath, buildClaudeLogin, readClaudeOauth, makeReadOnlyTokenSource, StaleCredentialsError, ExpiredRefreshTokenError } from '../../src/auth/claude.ts';

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
    const auth = new ClaudeAuth(fetchImpl, () => clock, tmpdir()); // temp home is inside this owned root

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
    const auth = new ClaudeAuth(fetchImpl, () => clock, tmpdir());
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

// ——— read-only token source (incident 2026-07-08: refresh tokens are single-use; a second owner
// rotating them orphans the first. Externally-owned homes must NEVER be refreshed by subtrack.) ———

test('makeReadOnlyTokenSource returns the access token, re-reading the file on every call', async () => {
  await withHome(async (home) => {
    const clock = 1_000_000;
    await writeCreds(home, { accessToken: 'cli-token', refreshToken: 'cli-r', expiresAt: clock + 60 * 60_000 });
    const source = makeReadOnlyTokenSource(home, () => clock);
    assert.equal(await source.getAccessToken(), 'cli-token');
    // the CLI rotates the file behind our back — the next call must see the new token
    await writeCreds(home, { accessToken: 'cli-token-2', refreshToken: 'cli-r2', expiresAt: clock + 60 * 60_000 });
    assert.equal(await source.getAccessToken(), 'cli-token-2');
  });
});

test('makeReadOnlyTokenSource never writes the credentials file back', async () => {
  await withHome(async (home) => {
    const clock = 1_000_000;
    await writeCreds(home, { accessToken: 'cli-token', refreshToken: 'cli-r', expiresAt: clock + 60 * 60_000 });
    const before = await readFile(claudeCredentialsPath(home), 'utf8');
    const source = makeReadOnlyTokenSource(home, () => clock);
    await source.getAccessToken();
    assert.equal(await readFile(claudeCredentialsPath(home), 'utf8'), before); // byte-identical
  });
});

test('makeReadOnlyTokenSource throws StaleCredentialsError when the file token is expired (never refreshes)', async () => {
  await withHome(async (home) => {
    const clock = 1_000_000;
    await writeCreds(home, { accessToken: 'old', refreshToken: 'cli-r', expiresAt: clock - 1 });
    const source = makeReadOnlyTokenSource(home, () => clock);
    await assert.rejects(() => source.getAccessToken(), StaleCredentialsError);
    await assert.rejects(() => source.getAccessToken(), /stale/i);
  });
});

test('makeReadOnlyTokenSource accepts a static long-lived token (no expiresAt) as-is', async () => {
  await withHome(async (home) => {
    await writeCreds(home, { accessToken: 'sk-ant-oat01-static' }); // setup-token: no refreshToken, no expiresAt
    const source = makeReadOnlyTokenSource(home, () => 9_999_999);
    assert.equal(await source.getAccessToken(), 'sk-ant-oat01-static');
  });
});

test('makeReadOnlyTokenSource throws an add-account hint when the file is missing', async () => {
  await withHome(async (home) => {
    const source = makeReadOnlyTokenSource(home, () => 0);
    await assert.rejects(() => source.getAccessToken(), /credentials/i);
  });
});

test('ClaudeAuth refuses to refresh credentials outside its owned root (double-ownership guard)', async () => {
  await withHome(async (home) => {
    // `home` is a CLI-style external dir — NOT under the owned root we pass here.
    const clock = 1_000_000;
    await writeCreds(home, { accessToken: 'cli', refreshToken: 'cli-r', expiresAt: clock - 1 });
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => { calls.push(String(url)); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const auth = new ClaudeAuth(fetchImpl, () => clock, join(tmpdir(), 'subtrack-owned-root-that-does-not-contain-home'));
    await assert.rejects(() => auth.getAccessToken(home), /refus.*refresh|read-only/i);
    assert.deepEqual(calls, []); // guard fires BEFORE any network call
    const persisted = await readClaudeOauth(home);
    assert.equal(persisted?.refreshToken, 'cli-r'); // file untouched
  });
});

test('ClaudeAuth still reads (without refresh) a fresh token outside the owned root', async () => {
  await withHome(async (home) => {
    const clock = 1_000_000;
    await writeCreds(home, { accessToken: 'cli', refreshToken: 'cli-r', expiresAt: clock + 10 * 60_000 });
    const fetchImpl = (async () => { throw new Error('no network expected'); }) as unknown as typeof fetch;
    const auth = new ClaudeAuth(fetchImpl, () => clock, join(tmpdir(), 'subtrack-owned-root-elsewhere'));
    assert.equal(await auth.getAccessToken(home), 'cli');
  });
});

test('refresh failure surfaces an error', async () => {
  await withHome(async (home) => {
    await writeCreds(home, { accessToken: 'old', refreshToken: 'r', expiresAt: 0 });
    const fetchImpl = (async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
    const auth = new ClaudeAuth(fetchImpl, () => 1, tmpdir());
    await assert.rejects(() => auth.getAccessToken(home), /refresh failed/i);
  });
});

// cc3 went dark on 2026-08-27 with a bare "Claude token refresh failed: HTTP 400" on the card. The
// body said invalid_grant / "Refresh token expired" — a dead refresh token no retry can revive.
test('an invalid_grant refresh failure names the cure (new login) instead of a bare HTTP 400', async () => {
  await withHome(async (home) => {
    await writeCreds(home, { accessToken: 'old', refreshToken: 'r', expiresAt: 0 });
    const fetchImpl = (async () => new Response('{"error": "invalid_grant", "error_description": "Refresh token expired"}', { status: 400 })) as unknown as typeof fetch;
    const auth = new ClaudeAuth(fetchImpl, () => 1, tmpdir());
    await assert.rejects(() => auth.getAccessToken(home), (e: unknown) => {
      assert.ok(e instanceof ExpiredRefreshTokenError);
      assert.match((e as Error).message, /refresh failed/i);           // still classified as auth_error upstream
      assert.match((e as Error).message, /CLAUDE_CONFIG_DIR|readonly/i); // and says what to do
      return true;
    });
  });
});

test('other refresh failures carry the status and the server body', async () => {
  await withHome(async (home) => {
    await writeCreds(home, { accessToken: 'old', refreshToken: 'r', expiresAt: 0 });
    const fetchImpl = (async () => new Response('upstream exploded', { status: 503 })) as unknown as typeof fetch;
    const auth = new ClaudeAuth(fetchImpl, () => 1, tmpdir());
    await assert.rejects(() => auth.getAccessToken(home), /HTTP 503 - upstream exploded/);
  });
});

test('refresh persists the refresh-token expiry the server reports', async () => {
  await withHome(async (home) => {
    const clock = 1_000_000;
    await writeCreds(home, { accessToken: 'old', refreshToken: 'r-old', expiresAt: clock - 1, refreshTokenExpiresAt: clock + 5 });
    const fetchImpl = (async () => new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r-new', expires_in: 28800, refresh_token_expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
    const auth = new ClaudeAuth(fetchImpl, () => clock, home);
    await auth.getAccessToken(home);
    assert.equal((await readClaudeOauth(home))?.refreshTokenExpiresAt, clock + 3600 * 1000);
  });
});

test('refresh keeps the known refresh-token expiry when the server omits it', async () => {
  await withHome(async (home) => {
    const clock = 1_000_000;
    await writeCreds(home, { accessToken: 'old', refreshToken: 'r-old', expiresAt: clock - 1, refreshTokenExpiresAt: 42 });
    const fetchImpl = (async () => new Response(JSON.stringify({ access_token: 'new', expires_in: 28800 }), { status: 200 })) as unknown as typeof fetch;
    const auth = new ClaudeAuth(fetchImpl, () => clock, home);
    await auth.getAccessToken(home);
    assert.equal((await readClaudeOauth(home))?.refreshTokenExpiresAt, 42);
  });
});
