import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedServices, ensureServices } from '../../src/ops/seed.ts';
import { saveServices, loadServices } from '../../src/ops/config.ts';
import type { SystemState } from '../../src/ops/types.ts';

const NOW = Date.parse('2026-07-15T09:00:00Z');
const sys: SystemState = {
  now: NOW,
  tasks: [
    { name: 'subtrack-dashboard', state: 'Ready', lastResult: 0, lastRun: null, nextRun: null },
    { name: 'radar_healthcheck', state: 'Ready', lastResult: 0, lastRun: null, nextRun: '2026-07-15T10:00:00' },
  ],
  ports: [7777],
  processes: [{ pid: 1, name: 'node', cmd: 'node serve' }],
};

test('seedServices makes one task-kind def per scheduled task', () => {
  const defs = seedServices(sys);
  const ids = defs.map((d) => d.id);
  assert.ok(ids.includes('subtrack-dashboard'));
  assert.ok(ids.includes('radar_healthcheck'));
  assert.equal(defs.find((d) => d.id === 'subtrack-dashboard')!.kind, 'task');
});

test('seedServices marks *_healthcheck / *_summary tasks as periodic (alwaysOn=false)', () => {
  const defs = seedServices(sys);
  assert.equal(defs.find((d) => d.id === 'radar_healthcheck')!.alwaysOn, false);
  assert.equal(defs.find((d) => d.id === 'subtrack-dashboard')!.alwaysOn, true);
});

async function withTempBase(fn: (base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-seed-'));
  try { await fn(base); } finally { await rm(base, { recursive: true, force: true }); }
}

test('ensureServices seeds and persists when the file is absent', async () => {
  await withTempBase(async (base) => {
    const defs = await ensureServices(base, sys);
    assert.ok(defs.length >= 2);
    assert.ok((await loadServices(base)).length >= 2); // persisted
  });
});

test('ensureServices leaves an existing manifest untouched', async () => {
  await withTempBase(async (base) => {
    await saveServices([{ id: 'only', label: 'Only', kind: 'port', port: 1, alwaysOn: true }], base);
    const defs = await ensureServices(base, sys);
    assert.deepEqual(defs.map((d) => d.id), ['only']);
  });
});

test('ensureServices does not reseed when the file exists but is empty', async () => {
  await withTempBase(async (base) => {
    await saveServices([], base);                       // deliberately empty, file exists
    const defs = await ensureServices(base, sys);
    assert.deepEqual(defs, []);                          // respected, NOT repopulated from sys
    assert.deepEqual(await loadServices(base), []);      // still empty on disk
  });
});
