import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.ts';
import { SnapshotStore } from '../src/snapshotStore.ts';
import type { FleetResponse, SetModeRequest, SetModeResult } from '../src/fleet/types.ts';

const EMPTY: FleetResponse = { windows: [], generatedAt: '2026-09-23T10:00:00.000Z', warnings: [], idleWindowMinutes: { min: 55, max: 1440 } };

async function withServer(
  opts: { getFleet?: () => Promise<FleetResponse>; setWindowMode?: (r: SetModeRequest) => Promise<SetModeResult> },
  fn: (base: string) => Promise<void>,
) {
  const app = createApp(new SnapshotStore(), { webDir: process.cwd(), uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60, grok: 60 }, ...opts });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const { port } = app.address() as { port: number };
  try { await fn(`http://127.0.0.1:${port}`); } finally { app.close(); }
}

test('GET /api/fleet returns the payload and never caches it', async () => {
  await withServer({ getFleet: async () => EMPTY }, async (base) => {
    const res = await fetch(`${base}/api/fleet`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await res.json() as FleetResponse).idleWindowMinutes, { min: 55, max: 1440 });
  });
});

test('/api/fleet is 405 for non-GET and 503 with no provider', async () => {
  await withServer({ getFleet: async () => EMPTY }, async (base) => {
    const res = await fetch(`${base}/api/fleet`, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
  });
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/api/fleet`)).status, 503);
    assert.equal((await fetch(`${base}/api/fleet/mode`, { method: 'POST', body: '{}' })).status, 503);
  });
});

test('POST /api/fleet/mode passes the request through and reports refusals as 400', async () => {
  const seen: SetModeRequest[] = [];
  const setWindowMode = async (r: SetModeRequest): Promise<SetModeResult> => {
    seen.push(r);
    if (r.mode === 'sleep' as 'off') throw new Error('mode must be ever, warm, off or auto');
    return { ok: true, mode: r.mode, pane: r.pane ?? null, cwd: r.cwd ?? '' };
  };
  await withServer({ setWindowMode }, async (base) => {
    const ok = await fetch(`${base}/api/fleet/mode`, { method: 'POST', body: JSON.stringify({ pane: 'w1:p1', cwd: 'C:\\p', mode: 'off' }) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as SetModeResult).mode, 'off');
    assert.equal(seen[0]?.pane, 'w1:p1');

    const bad = await fetch(`${base}/api/fleet/mode`, { method: 'POST', body: JSON.stringify({ pane: 'w1:p1', mode: 'sleep' }) });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/api/fleet/mode`, { method: 'POST', body: '{oops' })).status, 400);
  });
});

// The mark file is obeyed by two watchdogs, so a cross-origin page must not be able to flip it.
test('POST /api/fleet/mode rejects a cross-origin browser call', async () => {
  let called = 0;
  await withServer({ setWindowMode: async (r) => { called++; return { ok: true, mode: r.mode, pane: null, cwd: '' }; } }, async (base) => {
    const res = await fetch(`${base}/api/fleet/mode`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: JSON.stringify({ pane: 'w1:p1', mode: 'off' }),
    });
    assert.equal(res.status, 403);
    assert.equal(called, 0);
  });
});
