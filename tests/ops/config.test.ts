import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { servicesPath, loadServices, saveServices } from '../../src/ops/config.ts';
import type { ServiceDef } from '../../src/ops/types.ts';

async function withTempBase(fn: (base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-ops-'));
  try { await fn(base); } finally { await rm(base, { recursive: true, force: true }); }
}

test('servicesPath lives under <base>/.subtrack/services.json', () => {
  assert.match(servicesPath('/home/x'), /[\\/]\.subtrack[\\/]services\.json$/);
});

test('loadServices returns [] when the file is missing', async () => {
  await withTempBase(async (base) => {
    assert.deepEqual(await loadServices(base), []);
  });
});

test('saveServices then loadServices round-trips', async () => {
  await withTempBase(async (base) => {
    const defs: ServiceDef[] = [{ id: 'subtrack', label: 'Dashboard', kind: 'http', port: 7777, httpPath: '/api/health', alwaysOn: true, group: 'subtrack' }];
    await saveServices(defs, base);
    const back = await loadServices(base);
    assert.equal(back.length, 1);
    assert.equal(back[0]!.port, 7777);
  });
});
