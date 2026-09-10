import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { request } from 'node:http';
import { createApp, enrichUsage } from '../src/server.ts';
import { SnapshotStore } from '../src/snapshotStore.ts';
import type { NormalizedUsage } from '../src/types.ts';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

function usage(id: string, util: number, fable: NormalizedUsage['fable'] = null): NormalizedUsage {
  return { accountId: id, label: id, provider: 'claude', session: { utilization: util, resetsAt: '2026-06-29T17:00:00.000Z' }, weekly: null, weeklyOpus: null, fable, fableAccess: fable !== null, status: 'ok', lastUpdated: '2026-06-29T12:00:00.000Z', error: null, retryAt: null };
}

test('enrichUsage adds severity to windows', () => {
  const e = enrichUsage(usage('c1', 95));
  assert.equal(e.session?.severity, 'crit');
});

test('enrichUsage adds severity to the fable window', () => {
  const e = enrichUsage(usage('c1', 10, { utilization: 97, resetsAt: '2026-07-08T20:00:00.000Z' }));
  assert.equal(e.fable?.severity, 'crit');
  assert.equal(e.fable?.utilization, 97);
});

test('GET /api/usage sorts the Fable-maxed account first and exposes its bucket', async () => {
  const store = new SnapshotStore();
  store.set('low', usage('low', 20));
  store.set('fmax', usage('fmax', 20, { utilization: 100, resetsAt: '2026-07-08T20:00:00.000Z' }));
  await withServer(store, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/usage`);
    const body = await res.json() as { accounts: Array<{ accountId: string; fable: { utilization: number; severity: string } | null }> };
    assert.equal(body.accounts[0]!.accountId, 'fmax');            // tightest-first by fable
    assert.equal(body.accounts[0]!.fable?.utilization, 100);
    assert.equal(body.accounts[0]!.fable?.severity, 'crit');
  });
});

test('GET /api/usage exposes fableAccess per account (has-access vs no-access)', async () => {
  const store = new SnapshotStore();
  store.set('has', usage('has', 10, { utilization: 0, resetsAt: null })); // access, even at 0%
  store.set('none', usage('none', 10));                                   // no Fable access
  await withServer(store, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/usage`);
    const body = await res.json() as { accounts: Array<{ accountId: string; fable: unknown; fableAccess: boolean }> };
    const byId = Object.fromEntries(body.accounts.map((a) => [a.accountId, a]));
    assert.equal(byId['has']!.fableAccess, true);
    assert.notEqual(byId['has']!.fable, null);   // window present even at 0% utilization
    assert.equal(byId['none']!.fableAccess, false);
    assert.equal(byId['none']!.fable, null);
  });
});

async function withServer(store: SnapshotStore, fn: (baseUrl: string) => Promise<void>) {
  const server = createApp(store, { webDir, uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60, grok: 60 } });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try { await fn(`http://127.0.0.1:${port}`); } finally { await new Promise<void>((r) => server.close(() => r())); }
}

test('GET /api/usage returns enriched snapshot JSON', async () => {
  const store = new SnapshotStore();
  store.set('c1', usage('c1', 72));
  await withServer(store, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/usage`);
    assert.equal(res.status, 200);
    const body = await res.json() as { accounts: Array<{ session: { severity: string } }>; uiRefreshSeconds: number };
    assert.equal(body.accounts[0]!.session.severity, 'warn');
    assert.equal(body.uiRefreshSeconds, 30);
  });
});

test('GET /api/health returns ok', async () => {
  await withServer(new SnapshotStore(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal((await res.json() as { ok: boolean }).ok, true);
  });
});

function rawStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('blocks path traversal outside webDir with 403', async () => {
  const store = new SnapshotStore();
  const server = createApp(store, { webDir, uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60, grok: 60 } });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const code = await rawStatus(port, '/../../package.json'); // resolves outside webDir
    assert.equal(code, 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
