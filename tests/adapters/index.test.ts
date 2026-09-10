import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFetchUsage } from '../../src/adapters/index.ts';
import { CLAUDE_TOKEN_URL, ClaudeAuth, claudeCredentialsPath } from '../../src/auth/claude.ts';
import { Poller } from '../../src/poller.ts';
import { SnapshotStore } from '../../src/snapshotStore.ts';
import type { AccountConfig, SubtrackConfig } from '../../src/types.ts';

const USAGE_BODY = JSON.stringify({ five_hour: { utilization: 12, resets_at: '2026-07-08T15:00:00Z' }, seven_day: { utilization: 34, resets_at: '2026-07-14T00:00:00Z' } });

async function withHome(fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'subtrack-idx-'));
  try { await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}

async function writeCreds(home: string, oauth: Record<string, unknown>) {
  await writeFile(claudeCredentialsPath(home), JSON.stringify({ claudeAiOauth: oauth }), 'utf8');
}

/** fetch stub that records every requested URL and answers the usage endpoint with `usageStatus`. */
function recordingFetch(urls: string[], usageStatus = 200) {
  return (async (url: string | URL) => {
    urls.push(String(url));
    if (String(url) === CLAUDE_TOKEN_URL) return new Response(JSON.stringify({ access_token: 'ROTATED', refresh_token: 'ROTATED-R', expires_in: 28800 }), { status: 200 });
    return new Response(usageStatus === 200 ? USAGE_BODY : '', { status: usageStatus });
  }) as unknown as typeof fetch;
}

function roAccount(home: string): AccountConfig {
  return { id: 'cc-ro', label: 'readonly cli', provider: 'claude', enabled: true, credentialsHome: home, credentialsMode: 'readonly' };
}

test('readonly account with an EXPIRED token + refresh token present → stale, ZERO network calls, file untouched', async () => {
  await withHome(async (home) => {
    const clock = 1_000_000;
    // Worst case for the incident class: a refresh token is RIGHT THERE. A naive impl would use it.
    await writeCreds(home, { accessToken: 'expired', refreshToken: 'cli-owned-single-use', expiresAt: clock - 1 });
    const before = await readFile(claudeCredentialsPath(home), 'utf8');
    const urls: string[] = [];
    const fetchUsage = makeFetchUsage({ fetchImpl: recordingFetch(urls), clock: () => clock });
    const u = await fetchUsage(roAccount(home));
    assert.equal(u.status, 'stale');
    assert.deepEqual(urls, []); // no usage call with a known-dead token, and NEVER the token endpoint
    assert.equal(await readFile(claudeCredentialsPath(home), 'utf8'), before);
  });
});

test('readonly account with a fresh token → ok via the usage endpoint only, file untouched', async () => {
  await withHome(async (home) => {
    const clock = 1_000_000;
    await writeCreds(home, { accessToken: 'cli-token', refreshToken: 'cli-owned', expiresAt: clock + 60 * 60_000 });
    const before = await readFile(claudeCredentialsPath(home), 'utf8');
    const urls: string[] = [];
    const fetchUsage = makeFetchUsage({ fetchImpl: recordingFetch(urls), clock: () => clock });
    const u = await fetchUsage(roAccount(home));
    assert.equal(u.status, 'ok');
    assert.equal(u.weekly?.utilization, 34);
    assert.ok(urls.length >= 1 && urls.every((x) => x !== CLAUDE_TOKEN_URL));
    assert.equal(await readFile(claudeCredentialsPath(home), 'utf8'), before);
  });
});

test('incident regression: poller over a readonly account never hits the token endpoint or rewrites the creds file, even on 401', async () => {
  await withHome(async (home) => {
    let clock = 1_000_000;
    // Fresh-looking token that the server nevertheless rejects (401) — the owned path would
    // force-refresh here; the readonly path must only re-read the file and give up.
    await writeCreds(home, { accessToken: 'rejected', refreshToken: 'cli-owned-single-use', expiresAt: clock + 60 * 60_000 });
    const before = await readFile(claudeCredentialsPath(home), 'utf8');
    const urls: string[] = [];
    const config: SubtrackConfig = { version: 1, port: 0, uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60, grok: 60 }, accounts: [roAccount(home)] };
    const store = new SnapshotStore();
    const fetchUsage = makeFetchUsage({ fetchImpl: recordingFetch(urls, 401), clock: () => clock });
    const poller = new Poller({ config, fetchUsage, store, clock: () => clock });
    for (let i = 0; i < 3; i++) { await poller.tick(clock); clock += 20 * 60_000; } // ride through backoffs
    assert.equal(store.get('cc-ro')?.status, 'auth_error');
    assert.ok(urls.length > 0);
    assert.ok(urls.every((x) => x !== CLAUDE_TOKEN_URL), `token endpoint must never be called, saw: ${urls.join(', ')}`);
    assert.equal(await readFile(claudeCredentialsPath(home), 'utf8'), before); // byte-identical
  });
});

test('poller retries a stale readonly account at the normal TTL and recovers once the CLI refreshes the file', async () => {
  await withHome(async (home) => {
    let clock = 1_000_000;
    await writeCreds(home, { accessToken: 'expired', expiresAt: clock - 1 });
    const urls: string[] = [];
    const config: SubtrackConfig = { version: 1, port: 0, uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60, grok: 60 }, accounts: [roAccount(home)] };
    const store = new SnapshotStore();
    const fetchUsage = makeFetchUsage({ fetchImpl: recordingFetch(urls), clock: () => clock });
    const poller = new Poller({ config, fetchUsage, store, clock: () => clock });
    await poller.tick(clock);
    assert.equal(store.get('cc-ro')?.status, 'stale');
    // the CLI (the owner) rotates the file — next normal-TTL poll must pick it up
    await writeCreds(home, { accessToken: 'fresh-from-cli', refreshToken: 'r2', expiresAt: clock + 60 * 60_000 });
    clock += 181_000;
    await poller.tick(clock);
    assert.equal(store.get('cc-ro')?.status, 'ok');
    assert.ok(urls.every((x) => x !== CLAUDE_TOKEN_URL));
  });
});

test('owned account (no credentialsMode — legacy config) still auto-refreshes as before', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-owned-'));
  try {
    const ownedRoot = join(base, 'claude-homes');
    const home = join(ownedRoot, 'c1');
    await mkdir(home, { recursive: true });
    await writeCreds(home, { accessToken: 'old', refreshToken: 'r-old', expiresAt: 999 });
    const clock = 1_000_000;
    const urls: string[] = [];
    const fetchImpl = recordingFetch(urls);
    const acc: AccountConfig = { id: 'c1', label: 'owned', provider: 'claude', enabled: true, credentialsHome: home };
    const fetchUsage = makeFetchUsage({ fetchImpl, claudeAuth: new ClaudeAuth(fetchImpl, () => clock, ownedRoot) });
    const u = await fetchUsage(acc);
    assert.equal(u.status, 'ok');
    assert.ok(urls.includes(CLAUDE_TOKEN_URL)); // legacy owned path refreshed exactly as before
    const persisted = JSON.parse(await readFile(claudeCredentialsPath(home), 'utf8')) as { claudeAiOauth: { accessToken: string } };
    assert.equal(persisted.claudeAiOauth.accessToken, 'ROTATED');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
