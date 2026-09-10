import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.ts';
import { SnapshotStore } from '../src/snapshotStore.ts';
import type { ServicesResponse, ActionRequest, ActionResult } from '../src/ops/types.ts';

async function withServer(getServices: () => Promise<ServicesResponse>, fn: (base: string) => Promise<void>) {
  const app = createApp(new SnapshotStore(), { webDir: process.cwd(), uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60, grok: 60 }, getServices });
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

test('GET /api/services returns 500 when the provider throws', async () => {
  await withServer(async () => { throw new Error('boom'); }, async (base) => {
    const res = await fetch(`${base}/api/services`);
    assert.equal(res.status, 500);
  });
});

test('GET /api/services is 503 when no provider is wired', async () => {
  const app = createApp(new SnapshotStore(), { webDir: process.cwd(), uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60, grok: 60 } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const { port } = app.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/services`);
    assert.equal(res.status, 503);
  } finally { app.close(); }
});

async function withActionServer(runServiceAction: (r: ActionRequest) => Promise<ActionResult>, fn: (base: string) => Promise<void>) {
  const app = createApp(new SnapshotStore(), { webDir: process.cwd(), uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60, grok: 60 }, runServiceAction });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const { port } = app.address() as { port: number };
  try { await fn(`http://127.0.0.1:${port}`); } finally { app.close(); }
}

test('POST /api/services/action returns the executor result', async () => {
  const result: ActionResult = { ok: true, ran: 'restart Radar', output: 'STARTED' };
  await withActionServer(async () => result, async (base) => {
    const res = await fetch(`${base}/api/services/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'restart', id: 'radar' }) });
    assert.equal(res.status, 200);
    const body = await res.json() as ActionResult;
    assert.equal(body.ok, true);
  });
});

test('POST /api/services/action is 400 on malformed JSON', async () => {
  await withActionServer(async () => ({ ok: true, ran: 'x' }), async (base) => {
    const res = await fetch(`${base}/api/services/action`, { method: 'POST', body: '{not json' });
    assert.equal(res.status, 400);
  });
});

test('POST /api/services/action is 503 when no executor is wired', async () => {
  const app = createApp(new SnapshotStore(), { webDir: process.cwd(), uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60, grok: 60 } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const { port } = app.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/services/action`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 503);
  } finally { app.close(); }
});

test('POST /api/services/action rejects a cross-origin request with 403', async () => {
  // Use node:http (not fetch) so we can set an arbitrary Origin header reliably.
  await withActionServer(async () => ({ ok: true, ran: 'x' }), async (base) => {
    const port = Number(new URL(base).port);
    const status = await new Promise<number>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port, path: '/api/services/action', method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' } }, (res) => { res.resume(); resolve(res.statusCode!); });
      r.on('error', reject);
      r.end(JSON.stringify({ action: 'restart', id: 'radar' }));
    });
    assert.equal(status, 403);
  });
});

test('POST /api/services/action allows a matching loopback Origin', async () => {
  await withActionServer(async () => ({ ok: true, ran: 'x' }), async (base) => {
    const port = Number(new URL(base).port);
    const status = await new Promise<number>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port, path: '/api/services/action', method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` } }, (res) => { res.resume(); resolve(res.statusCode!); });
      r.on('error', reject);
      r.end(JSON.stringify({ action: 'restart', id: 'radar' }));
    });
    assert.equal(status, 200);
  });
});

test('POST /api/services/action returns 413 on an oversized body', async () => {
  await withActionServer(async () => ({ ok: true, ran: 'x' }), async (base) => {
    const res = await fetch(`${base}/api/services/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(1_100_000) });
    assert.equal(res.status, 413);
  });
});
