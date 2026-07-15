import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeHttp } from '../../src/ops/httpProbe.ts';

test('returns true on a 2xx response', async () => {
  const fake = async () => ({ ok: true, status: 200 }) as Response;
  assert.equal(await probeHttp(7777, '/api/health', 500, fake), true);
});

test('returns false on a non-2xx response', async () => {
  const fake = async () => ({ ok: false, status: 500 }) as Response;
  assert.equal(await probeHttp(7777, '/api/health', 500, fake), false);
});

test('returns undefined when the fetch throws (transport error/timeout)', async () => {
  const fake = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await probeHttp(7777, '/api/health', 500, fake), undefined);
});

test('targets 127.0.0.1 (never localhost)', async () => {
  let seen = '';
  const fake = async (url: string | URL) => { seen = String(url); return { ok: true, status: 204 } as Response; };
  await probeHttp(7777, '/api/health', 500, fake as typeof fetch);
  assert.match(seen, /^http:\/\/127\.0\.0\.1:7777\/api\/health$/);
});
