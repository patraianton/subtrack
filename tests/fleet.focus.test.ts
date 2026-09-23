import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFocusWindow } from '../src/fleet/focus.ts';
import type { HerdrResult } from '../src/fleet/panes.ts';

const PANE_LIST = JSON.stringify({
  id: 'cli:pane:list',
  result: {
    panes: [
      { agent: 'claude', agent_status: 'idle', cwd: 'C:\\p\\news', pane_id: 'w85:p1', tab_id: 'w85:t2', workspace_id: 'w85', agent_session: { value: 'sid' } },
      { agent: 'claude', agent_status: 'idle', cwd: 'C:\\p\\pricing', pane_id: 'w7Y:p2', workspace_id: 'w7Y', agent_session: { value: 'sid2' } },
    ],
  },
});

const ok: HerdrResult = { code: 0, stdout: '', stderr: '' };

function runner(calls: string[][], fail: (args: string[]) => boolean = () => false) {
  return async (args: string[]): Promise<HerdrResult> => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'list') return { code: 0, stdout: PANE_LIST, stderr: '' };
    return fail(args) ? { code: 1, stdout: '', stderr: 'no such workspace' } : ok;
  };
}

test('focusing a window switches the workspace, then its tab, then raises the terminal', async () => {
  const calls: string[][] = [];
  const scripts: string[] = [];
  const focus = makeFocusWindow({ run: runner(calls), pwsh: async (s) => { scripts.push(s); return { code: 0, stdout: 'raised\r\n', stderr: '' }; } });

  const result = await focus({ pane: 'w85:p1' });

  assert.deepEqual(result, { ok: true, pane: 'w85:p1', workspaceId: 'w85', raised: true, warning: null });
  assert.deepEqual(calls, [['pane', 'list'], ['workspace', 'focus', 'w85'], ['tab', 'focus', 'w85:t2']]);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0]!, /SetForegroundWindow/);
});

// A pane with no tab_id (older herdr builds) still gets its workspace switched.
test('a pane without a tab is still focused by workspace', async () => {
  const calls: string[][] = [];
  const result = await makeFocusWindow({ run: runner(calls) })({ pane: 'w7Y:p2' });
  assert.equal(result.ok, true);
  assert.equal(result.raised, false);        // no PowerShell runner injected
  assert.deepEqual(calls, [['pane', 'list'], ['workspace', 'focus', 'w7Y']]);
});

// The pane id is the only caller-supplied value, and it is checked twice: by shape, then against
// the live pane list. Neither check may let an unknown string reach a child process.
test('a malformed or unknown pane is refused before anything is focused', async () => {
  const calls: string[][] = [];
  const focus = makeFocusWindow({ run: runner(calls) });

  await assert.rejects(() => focus({ pane: 'w85:p1; shutdown' }), /pane required/);
  await assert.rejects(() => focus({ pane: '' }), /pane required/);
  assert.deepEqual(calls, []);

  await assert.rejects(() => focus({ pane: 'w99:p1' }), /no pane w99:p1/);
  assert.deepEqual(calls, [['pane', 'list']]);
});

test('herdr refusing the workspace is an error, a window that will not come to the front is a warning', async () => {
  const calls: string[][] = [];
  await assert.rejects(
    () => makeFocusWindow({ run: runner(calls, (a) => a[0] === 'workspace') })({ pane: 'w85:p1' }),
    /could not focus w85/,
  );

  const quiet = makeFocusWindow({
    run: runner([], (a) => a[0] === 'tab'),
    pwsh: async () => ({ code: 0, stdout: 'no-window', stderr: '' }),
  });
  const result = await quiet({ pane: 'w85:p1' });
  assert.equal(result.ok, true);
  assert.equal(result.raised, false);
  assert.match(result.warning ?? '', /tab w85:t2 not focused/);
  assert.match(result.warning ?? '', /not brought to the front/);
});
