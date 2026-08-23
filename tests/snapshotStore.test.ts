import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotStore } from '../src/snapshotStore.ts';
import type { NormalizedUsage } from '../src/types.ts';

function usage(id: string): NormalizedUsage {
  return { accountId: id, label: id, provider: 'claude', session: null, weekly: null, weeklyOpus: null, fable: null, fableAccess: false, status: 'ok', lastUpdated: '2026-06-29T12:00:00.000Z', error: null, retryAt: null };
}

test('set/get/all', () => {
  const s = new SnapshotStore();
  assert.equal(s.get('a'), undefined);
  s.set('a', usage('a'));
  s.set('b', usage('b'));
  assert.equal(s.get('a')?.accountId, 'a');
  assert.deepEqual(s.all().map((u) => u.accountId).sort(), ['a', 'b']);
});
