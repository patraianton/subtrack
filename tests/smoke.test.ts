import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedUsage } from '../src/types.ts';

test('toolchain runs TypeScript tests and types import', () => {
  const u: NormalizedUsage = {
    accountId: 'x', label: 'X', provider: 'claude',
    session: null, weekly: null, weeklyOpus: null, fable: null, fableAccess: false,
    status: 'ok', lastUpdated: '2026-06-29T00:00:00.000Z', error: null, retryAt: null,
  };
  assert.equal(u.provider, 'claude');
});
