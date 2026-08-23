import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HermesMonitorSupervisor, type SupervisedHermesMonitor } from '../../src/hermes/supervisor.ts';
import type { ServiceHealth } from '../../src/ops/types.ts';

function row(): ServiceHealth {
  return {
    id: 'hermes-fleet', label: 'Hermes fleet', kind: 'hermes', alwaysOn: true, group: 'Hermes fleet',
    status: 'up', detail: '7/7 profiles healthy', pid: null, lastRun: null, nextRun: null,
  };
}

test('initialization failure stays visible and a bounded retry replaces it with the live monitor', async () => {
  let creates = 0;
  let starts = 0;
  let stops = 0;
  let retry: (() => void) | null = null;
  let delay = 0;
  const monitor: SupervisedHermesMonitor = {
    start: () => { starts += 1; }, stop: () => { stops += 1; }, serviceRows: () => [row()],
  };
  const supervisor = new HermesMonitorSupervisor({
    now: () => Date.parse('2026-07-17T12:00:00Z'),
    create: async () => {
      creates += 1;
      if (creates === 1) throw new Error('secret path C:\\private\\auth.json');
      return monitor;
    },
    setTimeoutImpl: ((callback: () => void, milliseconds: number) => {
      retry = callback; delay = milliseconds;
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }),
    clearTimeoutImpl: () => {},
  });
  await supervisor.start();
  const failed = supervisor.serviceRows();
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.status, 'unknown');
  assert.doesNotMatch(failed[0]!.detail, /private|auth\.json/);
  assert.equal(delay, 60_000);
  assert.ok(retry);
  (retry as () => void)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(creates, 2);
  assert.equal(starts, 1);
  assert.equal(supervisor.serviceRows()[0]!.status, 'up');
  supervisor.stop();
  assert.equal(stops, 1);
});

test('stop during initialization prevents a late monitor from starting', async () => {
  let release!: (monitor: SupervisedHermesMonitor) => void;
  let starts = 0;
  let stops = 0;
  const pending = new Promise<SupervisedHermesMonitor>((resolve) => { release = resolve; });
  const supervisor = new HermesMonitorSupervisor({ create: async () => await pending });
  const starting = supervisor.start();
  supervisor.stop();
  release({
    start: () => { starts += 1; }, stop: () => { stops += 1; }, serviceRows: () => [row()],
  });
  await starting;
  assert.equal(starts, 0);
  assert.equal(stops, 1);
  assert.deepEqual(supervisor.serviceRows(), []);
});
