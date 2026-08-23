import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCountdown } from '../../web/format.js';

const now = Date.parse('2026-06-29T12:00:00.000Z');

test('minutes under an hour', () => {
  assert.equal(formatCountdown('2026-06-29T12:45:00.000Z', now), '45m');
});
test('hours and minutes', () => {
  assert.equal(formatCountdown('2026-06-29T13:44:00.000Z', now), '1h44m');
});
test('days and hours', () => {
  assert.equal(formatCountdown('2026-07-02T15:00:00.000Z', now), '3d3h');
});
test('past resets show now', () => {
  assert.equal(formatCountdown('2026-06-29T11:59:00.000Z', now), 'now');
});
test('null/absent reset time shows an em-dash, not "now"', () => {
  assert.equal(formatCountdown(null, now), '—');
  assert.equal(formatCountdown(undefined, now), '—');
  assert.equal(formatCountdown('not-a-date', now), '—');
});
