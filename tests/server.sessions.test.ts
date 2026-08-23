import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.ts';
import { SnapshotStore } from '../src/snapshotStore.ts';
import type { SessionsResponse } from '../src/sessions/types.ts';

async function withServer(
  getSessions: (() => Promise<SessionsResponse>) | undefined,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = createApp(new SnapshotStore(), {
    webDir: process.cwd(),
    uiRefreshSeconds: 30,
    pollIntervalSeconds: { claude: 180, codex: 60, grok: 60 },
    getSessions,
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const { port } = app.address() as { port: number };
  try { await fn(`http://127.0.0.1:${port}`); } finally { app.close(); }
}

const PAYLOAD: SessionsResponse = {
  windows: [],
  sessions: [],
  generatedAt: '2026-07-15T12:00:00.000Z',
  recentHours: 24,
  partial: false,
  warnings: [],
};

test('GET /api/sessions returns the provider payload without browser caching', async () => {
  await withServer(async () => PAYLOAD, async (base) => {
    const response = await fetch(`${base}/api/sessions`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), PAYLOAD);
  });
});

test('GET /api/sessions returns 503 with no-store when no provider is wired', async () => {
  await withServer(undefined, async (base) => {
    const response = await fetch(`${base}/api/sessions`);

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'sessions unavailable' });
  });
});

test('GET /api/sessions returns 500 with no-store when the provider throws', async () => {
  await withServer(async () => { throw new Error('snapshot failed'); }, async (base) => {
    const response = await fetch(`${base}/api/sessions`);

    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'sessions failed', detail: 'snapshot failed' });
  });
});

test('non-GET /api/sessions is rejected without invoking the provider', async () => {
  let calls = 0;
  await withServer(async () => { calls++; return PAYLOAD; }, async (base) => {
    const response = await fetch(`${base}/api/sessions`, { method: 'POST' });

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(calls, 0);
  });
});
