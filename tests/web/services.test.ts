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
