import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.ts';
import { SnapshotStore } from '../src/snapshotStore.ts';
import type { BurnResponse } from '../src/burn/types.ts';
import type { NormalizedUsage } from '../src/types.ts';

const PAYLOAD: BurnResponse = {
  accountId: 'claude-4',
  accountLabel: 'cc4 · test',
  windowStart: '2026-09-05T08:00:00.000Z',
  resetsAt: '2026-09-05T13:00:00.000Z',
  windowHours: 5,
  sessions: [],
  totals: { weight: 0, replies: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
  otherSessions: 0,
  generatedAt: '2026-09-05T11:00:00.000Z',
  partial: false,
  warnings: [],
};

function snapshot(accountId: string, resetsAt: string | null): NormalizedUsage {
  return {
    accountId,
    label: `${accountId} · test`,
    provider: 'claude',
    session: { utilization: 95, resetsAt },
    weekly: null,
    weeklyOpus: null,
    fable: null,
    fableAccess: true,
    status: 'ok',
    lastUpdated: '2026-09-05T11:00:00.000Z',
    error: null,
    retryAt: null,
  };
}

async function withServer(
  getBurn: ((accountId: string, resetsAt: string | null) => Promise<BurnResponse>) | undefined,
  fn: (base: string) => Promise<void>,
  store: SnapshotStore = new SnapshotStore(),
): Promise<void> {
  const app = createApp(store, {
    webDir: process.cwd(),
    uiRefreshSeconds: 30,
    pollIntervalSeconds: { claude: 180, codex: 60, grok: 60 },
    getBurn,
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const { port } = app.address() as { port: number };
  try { await fn(`http://127.0.0.1:${port}`); } finally { app.close(); }
}

test('GET /api/burn anchors the window on the account snapshot reset and never caches in the browser', async () => {
  const store = new SnapshotStore();
  store.set('claude-4', snapshot('claude-4', '2026-09-05T13:00:00.000Z'));
  const seen: { accountId: string; resetsAt: string | null }[] = [];
  await withServer(async (accountId, resetsAt) => { seen.push({ accountId, resetsAt }); return PAYLOAD; }, async (base) => {
    const response = await fetch(`${base}/api/burn?account=claude-4`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), PAYLOAD);
    assert.deepEqual(seen, [{ accountId: 'claude-4', resetsAt: '2026-09-05T13:00:00.000Z' }]);
  }, store);
});

test('GET /api/burn passes a null reset when the account has no snapshot yet', async () => {
  let received: string | null | undefined;
  await withServer(async (_accountId, resetsAt) => { received = resetsAt; return PAYLOAD; }, async (base) => {
    await fetch(`${base}/api/burn?account=claude-9`);
    assert.equal(received, null);
  });
});

test('GET /api/burn requires an account', async () => {
  await withServer(async () => PAYLOAD, async (base) => {
    const response = await fetch(`${base}/api/burn`);

    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'account query parameter required' });
  });
});

test('/api/burn is GET-only and reports an unwired or failing provider honestly', async () => {
  await withServer(async () => PAYLOAD, async (base) => {
    const response = await fetch(`${base}/api/burn?account=claude-4`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
  });

  await withServer(undefined, async (base) => {
    const response = await fetch(`${base}/api/burn?account=claude-4`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'burn unavailable' });
  });

  await withServer(async () => { throw new Error('scan failed'); }, async (base) => {
    const response = await fetch(`${base}/api/burn?account=claude-4`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'burn failed', detail: 'scan failed' });
  });
});
