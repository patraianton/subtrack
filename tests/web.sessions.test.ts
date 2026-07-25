import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterSessions, renderLiveWindows, renderSessionHistory } from '../web/sessions.js';

test('Sessions renderers escape local metadata and keep resume commands out of HTML', () => {
  const commands = new Map<string, string>();
  const command = `Set-Location 'C:\\secret'; claude --resume 'private-id'`;
  const html = renderLiveWindows([{
    pid: 42,
    accountLabel: '<img src=x onerror=alert(1)>',
    launcher: 'cc3',
    project: 'safe',
    folder: 'safe',
    cwd: 'C:\\work\\<script>alert(1)</script>',
    sessionId: 'visible-id',
    launchSessionId: 'visible-id',
    binding: 'launch',
    title: '<b>unsafe</b>',
    resumeCommand: command,
  }], commands);

  assert.doesNotMatch(html, /<script>|<img|<b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /private-id|C:\\secret/);
  assert.equal(commands.get('window-0'), command);
});

test('Sessions history defaults can select working rows and search exact folders', () => {
  const sessions = [
    { provider: 'claude', activity: 'open', cwd: 'C:\\work\\alpha', title: 'Alpha', lastActivity: '2026-07-15T10:00:00Z' },
    { provider: 'codex', activity: 'recent', cwd: 'C:\\work\\beta', title: 'Beta', lastActivity: '2026-07-15T11:00:00Z' },
    { provider: 'claude', activity: 'idle', cwd: 'C:\\archive\\gamma', title: 'Gamma', lastActivity: '2026-07-01T10:00:00Z' },
  ];

  assert.deepEqual(filterSessions(sessions, { scope: 'working', provider: 'all' }).map((row: { title: string }) => row.title), ['Alpha', 'Beta']);
  assert.deepEqual(filterSessions(sessions, { scope: 'all', provider: 'codex', query: 'beta' }).map((row: { title: string }) => row.title), ['Beta']);
  assert.match(renderSessionHistory([], new Map()), /No sessions match/);
});
