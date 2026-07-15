import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderServices } from '../../web/services.js';

const data = {
  services: [
    { id: 'a', label: 'Dashboard', group: 'subtrack', kind: 'http', status: 'up', detail: 'http 2xx on :7777/api/health', alwaysOn: true, pid: null, lastRun: null, nextRun: null },
    { id: 'b', label: 'Radar throughput', group: 'radar', kind: 'task', status: 'down', detail: 'task not registered', alwaysOn: true, pid: null, lastRun: null, nextRun: null },
  ],
  untracked: [{ kind: 'port', port: 9999, pid: 5, name: 'node', cmd: 'node ghost.js' }],
  generatedAt: '2026-07-15T09:00:00.000Z',
};

test('renderServices shows each service label and status class', () => {
  const html = renderServices(data, Date.parse(data.generatedAt));
  assert.match(html, /Dashboard/);
  assert.match(html, /Radar throughput/);
  assert.match(html, /status-up/);
  assert.match(html, /status-down/);
});

test('renderServices lists untracked runners', () => {
  const html = renderServices(data, Date.parse(data.generatedAt));
  assert.match(html, /9999/);
  assert.match(html, /Untracked/i);
});

test('renderServices escapes service labels', () => {
  const evil = { ...data, services: [{ ...data.services[0], label: '<img src=x>' }], untracked: [] };
  const html = renderServices(evil, 0);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;img/);
});

test('renderServices adds restart/stop buttons for services with a taskName', () => {
  const data = {
    services: [
      { id: 'radar', label: 'Radar', group: 'radar', kind: 'task', taskName: 'Radar-Spike8', status: 'down', detail: '...', alwaysOn: true, pid: null, lastRun: null, nextRun: null },
      { id: 'web', label: 'Web', group: 'web', kind: 'http', status: 'up', detail: '...', alwaysOn: true, pid: null, lastRun: null, nextRun: null },
    ],
    untracked: [],
    generatedAt: '2026-07-15T09:00:00.000Z',
  };
  const html = renderServices(data, 0);
  assert.match(html, /data-action="restart"[^>]*data-id="radar"/);
  assert.match(html, /data-action="stop"[^>]*data-id="radar"/);
  // a service with no taskName gets no restart button
  assert.doesNotMatch(html, /data-action="restart"[^>]*data-id="web"/);
});

test('renderServices adds a register button for untracked runners', () => {
  const data = { services: [], untracked: [{ kind: 'port', port: 9999, pid: 5, name: 'node', cmd: 'node ghost.js' }], generatedAt: '2026-07-15T09:00:00.000Z' };
  const html = renderServices(data, 0);
  assert.match(html, /data-action="register"[^>]*data-pid="5"/);
});
