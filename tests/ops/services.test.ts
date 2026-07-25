import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGetServices } from '../../src/ops/services.ts';
import { saveServices } from '../../src/ops/config.ts';

const SAMPLE = JSON.stringify({
  tasks: [{ name: 'subtrack-dashboard', state: 'Ready', lastResult: 0, lastRun: null, nextRun: null }],
  ports: [7777, 9999],
  processes: [{ pid: 5, name: 'node', cmd: 'node ghost-runner.js' }],
});

async function withTempBase(fn: (base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-svc-'));
  try { await fn(base); } finally { await rm(base, { recursive: true, force: true }); }
}

test('probes each configured service and returns health', async () => {
  await withTempBase(async (base) => {
    await saveServices([{ id: 'dash', label: 'Dash', kind: 'http', port: 7777, httpPath: '/api/health', alwaysOn: true }], base);
    const get = makeGetServices({
      base,
      run: async () => ({ code: 0, stdout: SAMPLE, stderr: '' }),
      httpProbe: async () => true,
      now: () => 1,
    });
    const res = await get();
    assert.equal(res.services.length, 1);
    assert.equal(res.services[0]!.status, 'up');
  });
});

test('detects untracked runners (a listening port with no service claiming it)', async () => {
  await withTempBase(async (base) => {
    await saveServices([{ id: 'dash', label: 'Dash', kind: 'port', port: 7777, alwaysOn: true }], base);
    const get = makeGetServices({ base, run: async () => ({ code: 0, stdout: SAMPLE, stderr: '' }), httpProbe: async () => true, now: () => 1 });
    const res = await get();
    // :9999 is listening but no def references it -> untracked.
    assert.ok(res.untracked.some((u) => u.port === 9999));
  });
});

test('caches within cacheMs (the gatherer runs once for two quick calls)', async () => {
  await withTempBase(async (base) => {
    await saveServices([{ id: 'dash', label: 'Dash', kind: 'port', port: 7777, alwaysOn: true }], base);
    let runs = 0;
    const get = makeGetServices({
      base,
      run: async () => { runs++; return { code: 0, stdout: SAMPLE, stderr: '' }; },
      httpProbe: async () => true,
      now: () => 1000,      // constant clock -> both calls inside the window
      cacheMs: 10_000,
    });
    await get(); await get();
    assert.equal(runs, 1);
  });
});

test('merges the latest background Hermes rows without probing them from the GET path', async () => {
  await withTempBase(async (base) => {
    await saveServices([], base);
    let reads = 0;
    const get = makeGetServices({
      base,
      run: async () => ({ code: 0, stdout: SAMPLE, stderr: '' }),
      now: () => 1000,
      additionalServices: () => {
        reads++;
        return [{ id: 'hermes-alexey', label: 'alexey', kind: 'hermes', alwaysOn: true, group: 'Hermes', status: 'up', detail: 'gateway running', pid: 42, lastRun: null, nextRun: null, checkedAt: '2026-07-17T12:00:00Z', autoHeal: true }];
      },
    });
    const result = await get();
    assert.equal(result.services.find((service) => service.id === 'hermes-alexey')?.status, 'up');
    await get();
    assert.equal(reads, 1, 'the normal Services cache reuses the monitor snapshot');
  });
});
