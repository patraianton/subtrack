import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystemState, gatherSystemState } from '../../src/ops/windows.ts';

const NOW = Date.parse('2026-07-15T09:00:00Z');

const SAMPLE = JSON.stringify({
  tasks: [
    { name: 'subtrack-dashboard', state: 'Ready', lastResult: 0, lastRun: '2026-07-15T08:07:00', nextRun: null },
    { name: 'radar_healthcheck', state: 'Ready', lastResult: 267011, lastRun: '2026-07-15T08:00:00', nextRun: '2026-07-15T09:00:00' },
  ],
  ports: [7777, 11434],
  processes: [{ pid: 21240, name: 'node', cmd: 'node serve' }],
});

test('parseSystemState maps the JSON blob into SystemState', () => {
  const sys = parseSystemState(SAMPLE, NOW);
  assert.equal(sys.now, NOW);
  assert.equal(sys.tasks.length, 2);
  assert.equal(sys.tasks[0]!.name, 'subtrack-dashboard');
  assert.equal(sys.tasks[1]!.lastResult, 267011);
  assert.deepEqual(sys.ports, [7777, 11434]);
  assert.equal(sys.processes[0]!.pid, 21240);
});

test('parseSystemState tolerates a single-object (non-array) tasks field from ConvertTo-Json', () => {
  // PowerShell ConvertTo-Json emits a bare object (not a 1-element array) for single items.
  const one = JSON.stringify({ tasks: { name: 't', state: 'Ready', lastResult: 0, lastRun: null, nextRun: null }, ports: 7777, processes: {} });
  const sys = parseSystemState(one, NOW);
  assert.equal(sys.tasks.length, 1);
  assert.deepEqual(sys.ports, [7777]);
  assert.equal(sys.processes.length, 0); // empty object -> dropped
});

test('gatherSystemState feeds runner stdout through the parser', async () => {
  const run = async () => ({ code: 0, stdout: SAMPLE, stderr: '' });
  const sys = await gatherSystemState(run, NOW);
  assert.equal(sys.ports.length, 2);
});

test('gatherSystemState returns an empty snapshot when PowerShell fails', async () => {
  const run = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  const sys = await gatherSystemState(run, NOW);
  assert.deepEqual(sys, { tasks: [], ports: [], processes: [], now: NOW });
});
