import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.ts';
import { SnapshotStore } from '../src/snapshotStore.ts';
import type { ServicesResponse } from '../src/ops/types.ts';

async function withServer(getServices: () => Promise<ServicesResponse>, fn: (base: string) => Promise<void>) {
  const app = createApp(new SnapshotStore(), { webDir: process.cwd(), uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60 }, getServices });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const { port } = app.address() as { port: number };
  try { await fn(`http://127.0.0.1:${port}`); } finally { app.close(); }
}

test('GET /api/services returns the provider payload', async () => {
  const payload: ServicesResponse = { services: [{ id: 'x', label: 'X', kind: 'port', port: 7777, alwaysOn: true, status: 'up', detail: 'ok', pid: null, lastRun: null, nextRun: null }], untracked: [], generatedAt: '2026-07-15T09:00:00.000Z' };
  await withServer(async () => payload, async (base) => {
    const res = await fetch(`${base}/api/services`);
    assert.equal(res.status, 200);
    const body = await res.json() as ServicesResponse;
    assert.equal(body.services[0]!.status, 'up');
  });
});

test('GET /api/services is 503 when no provider is wired', async () => {
  const app = createApp(new SnapshotStore(), { webDir: process.cwd(), uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60 } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const { port } = app.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/services`);
    assert.equal(res.status, 503);
  } finally { app.close(); }
});
