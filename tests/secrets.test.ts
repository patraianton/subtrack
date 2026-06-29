import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySecretStore } from '../src/secrets.ts';

test('MemorySecretStore set/get/delete round-trip', async () => {
  const s = new MemorySecretStore();
  assert.equal(await s.get('k'), null);
  await s.set('k', 'secret-value');
  assert.equal(await s.get('k'), 'secret-value');
  await s.delete('k');
  assert.equal(await s.get('k'), null);
});

test('MemorySecretStore overwrites existing key', async () => {
  const s = new MemorySecretStore();
  await s.set('k', 'a');
  await s.set('k', 'b');
  assert.equal(await s.get('k'), 'b');
});
