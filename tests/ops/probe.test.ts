import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeService } from '../../src/ops/probe.ts';
import type { ServiceDef, SystemState } from '../../src/ops/types.ts';

const NOW = Date.parse('2026-07-15T09:00:00Z');
const emptySys: SystemState = { tasks: [], ports: [], processes: [], now: NOW };

function def(over: Partial<ServiceDef>): ServiceDef {
  return { id: 'x', label: 'X', kind: 'port', alwaysOn: true, ...over };
}

test('port kind: up when the port is listening', () => {
  const sys: SystemState = { ...emptySys, ports: [7777] };
  const h = probeService(def({ kind: 'port', port: 7777 }), sys);
  assert.equal(h.status, 'up');
});

test('port kind: down when the port is not listening', () => {
  const h = probeService(def({ kind: 'port', port: 7777 }), emptySys);
  assert.equal(h.status, 'down');
});

test('http kind: up when httpOk is true', () => {
  const sys: SystemState = { ...emptySys, ports: [7777] };
  const h = probeService(def({ kind: 'http', port: 7777, httpPath: '/api/health' }), sys, true);
  assert.equal(h.status, 'up');
});

test('http kind: degraded when port listens but http fails', () => {
  const sys: SystemState = { ...emptySys, ports: [7777] };
  const h = probeService(def({ kind: 'http', port: 7777, httpPath: '/api/health' }), sys, false);
  assert.equal(h.status, 'degraded');
});

test('http kind: down when neither port nor http answers', () => {
  const h = probeService(def({ kind: 'http', port: 7777, httpPath: '/api/health' }), emptySys, false);
  assert.equal(h.status, 'down');
});

test('http kind: unknown when the probe errored (httpOk undefined)', () => {
  const sys: SystemState = { ...emptySys, ports: [7777] };
  const h = probeService(def({ kind: 'http', port: 7777, httpPath: '/api/health' }), sys, undefined);
  assert.equal(h.status, 'unknown');
});

test('process kind: up with pid when a process matches (name or cmd)', () => {
  const sys: SystemState = { ...emptySys, processes: [{ pid: 42, name: 'pythonw', cmd: 'pythonw hermes gateway designbot' }] };
  const h = probeService(def({ kind: 'process', match: 'hermes.*designbot' }), sys);
  assert.equal(h.status, 'up');
  assert.equal(h.pid, 42);
});

test('process kind: down when nothing matches', () => {
  const h = probeService(def({ kind: 'process', match: 'nope' }), emptySys);
  assert.equal(h.status, 'down');
});

test('task kind: down when the task is not registered', () => {
  const h = probeService(def({ kind: 'task', taskName: 'ghost' }), emptySys);
  assert.equal(h.status, 'down');
  assert.match(h.detail, /not registered/);
});

test('task kind: down when the task is disabled', () => {
  const sys: SystemState = { ...emptySys, tasks: [{ name: 't', state: 'Disabled', lastResult: 0, lastRun: null, nextRun: null }] };
  const h = probeService(def({ kind: 'task', taskName: 't' }), sys);
  assert.equal(h.status, 'down');
});

test('task kind: degraded when the last run failed', () => {
  const sys: SystemState = { ...emptySys, tasks: [{ name: 't', state: 'Ready', lastResult: 1, lastRun: '2026-07-15', nextRun: null }] };
  const h = probeService(def({ kind: 'task', taskName: 't' }), sys);
  assert.equal(h.status, 'degraded');
});

test('always-on task with a port: up when the port listens, degraded when it does not', () => {
  const base = def({ kind: 'task', taskName: 't', port: 7777, alwaysOn: true });
  const t = { name: 't', state: 'Ready', lastResult: 0, lastRun: '2026-07-15', nextRun: null };
  assert.equal(probeService(base, { ...emptySys, tasks: [t], ports: [7777] }).status, 'up');
  assert.equal(probeService(base, { ...emptySys, tasks: [t], ports: [] }).status, 'degraded');
});

test('periodic task (alwaysOn=false): Ready + last ok is up, ignoring ports', () => {
  const sys: SystemState = { ...emptySys, tasks: [{ name: 'hc', state: 'Ready', lastResult: 0, lastRun: '2026-07-15', nextRun: '2026-07-16' }] };
  const h = probeService(def({ kind: 'task', taskName: 'hc', port: 9999, alwaysOn: false }), sys);
  assert.equal(h.status, 'up');
});

test('running task is up', () => {
  const sys: SystemState = { ...emptySys, tasks: [{ name: 't', state: 'Running', lastResult: 0, lastRun: '2026-07-15', nextRun: null }] };
  assert.equal(probeService(def({ kind: 'task', taskName: 't' }), sys).status, 'up');
});

test('process kind: unknown (not down) when no match pattern is configured', () => {
  const h = probeService(def({ kind: 'process', match: undefined }), emptySys);
  assert.equal(h.status, 'unknown');
});

test('process kind: unknown when the match regex is invalid', () => {
  const h = probeService(def({ kind: 'process', match: '(' }), emptySys);
  assert.equal(h.status, 'unknown');
});

test('task kind: benign SCHED_S_* result codes (running / not-yet-run) are not failures', () => {
  for (const r of [267009 /* 0x41301 running */, 267011 /* 0x41303 not yet run */]) {
    const sys = { ...emptySys, tasks: [{ name: 't', state: 'Ready', lastResult: r, lastRun: null, nextRun: null }] };
    assert.equal(probeService(def({ kind: 'task', taskName: 't' }), sys).status, 'up', `code ${r}`);
  }
});

test('task kind: a genuine nonzero failure code is degraded', () => {
  const sys = { ...emptySys, tasks: [{ name: 't', state: 'Ready', lastResult: 1, lastRun: null, nextRun: null }] };
  assert.equal(probeService(def({ kind: 'task', taskName: 't' }), sys).status, 'degraded');
});
