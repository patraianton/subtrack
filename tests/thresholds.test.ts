import { test } from 'node:test';
import assert from 'node:assert/strict';
import { severityFor } from '../src/thresholds.ts';

test('severityFor maps bands', () => {
  assert.equal(severityFor(0), 'ok');
  assert.equal(severityFor(69.9), 'ok');
  assert.equal(severityFor(70), 'warn');
  assert.equal(severityFor(89.9), 'warn');
  assert.equal(severityFor(90), 'crit');
  assert.equal(severityFor(100), 'crit');
});
