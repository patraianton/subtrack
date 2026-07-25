import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveClaudeWindows } from '../../src/sessions/windows.ts';

test('parseLiveClaudeWindows accepts PowerShell single-object output', () => {
  const rows = parseLiveClaudeWindows(JSON.stringify({
    windows: {
      pid: 42,
      startedAt: '2026-07-15T08:20:00.000Z',
      configDir: 'C:\\Users\\test\\.claude-accounts\\3-work',
      cwd: 'C:\\work\\project',
      launchSessionId: '8a12a60a-1111-2222-3333-444444444444',
    },
  }));

  assert.deepEqual(rows, [{
    pid: 42,
    startedAt: '2026-07-15T08:20:00.000Z',
    configDir: 'C:\\Users\\test\\.claude-accounts\\3-work',
    cwd: 'C:\\work\\project',
    launchSessionId: '8a12a60a-1111-2222-3333-444444444444',
  }]);
});

test('parseLiveClaudeWindows accepts arrays and drops rows without a numeric pid', () => {
  const rows = parseLiveClaudeWindows(JSON.stringify({
    windows: [
      { pid: '73', startedAt: null, configDir: '', cwd: null, launchSessionId: '' },
      { pid: 'not-a-pid', cwd: 'C:\\ignored' },
      { pid: null, cwd: 'C:\\also-ignored' },
      { pid: 0, cwd: 'C:\\also-ignored' },
      { pid: -1, cwd: 'C:\\also-ignored' },
      null,
    ],
  }));

  assert.deepEqual(rows, [{
    pid: 73,
    startedAt: new Date(0).toISOString(),
    configDir: null,
    cwd: null,
    launchSessionId: null,
  }]);
});

test('parseLiveClaudeWindows rejects malformed JSON', () => {
  assert.throws(
    () => parseLiveClaudeWindows('{not json'),
    /Claude window snapshot returned malformed JSON/,
  );
});
