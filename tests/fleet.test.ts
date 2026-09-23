import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMode, markFor, modesPath, parseMarks, readMarks, stamp, writeMarks } from '../src/fleet/modes.ts';
import { parsePanes, type HerdrRunner } from '../src/fleet/panes.ts';
import { makeGetFleet, makeSetWindowMode, verdict } from '../src/fleet/fleet.ts';
import type { ModeMark } from '../src/fleet/types.ts';
import type { SessionsResponse, WorkSession } from '../src/sessions/types.ts';

async function withTempBase(fn: (base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-fleet-'));
  try { await fn(base); } finally { await rm(base, { recursive: true, force: true }); }
}

const PANE_LIST = JSON.stringify({
  id: 'cli:pane:list',
  result: {
    panes: [
      { agent: 'claude', agent_status: 'idle', cwd: 'C:\\Users\\<user>\\projects\\news', pane_id: 'w85:p1', tab_id: 'w85:t1', workspace_id: 'w85', focused: false, terminal_title_stripped: 'News digest', agent_session: { value: 'sid-news' } },
      { agent: 'claude', agent_status: 'working', cwd: 'C:\\Users\\<user>\\projects\\pricing', pane_id: 'w7Y:p2', workspace_id: 'w7Y', focused: true, terminal_title_stripped: 'Pricing', agent_session: { value: 'sid-pricing' } },
      { agent: 'codex', agent_status: 'idle', cwd: 'C:\\Users\\<user>\\projects\\other', pane_id: 'w1:p1', workspace_id: 'w1', agent_session: { value: 'sid-codex' } },
    ],
  },
});

const WORKSPACE_LIST = JSON.stringify({
  id: 'cli:workspace:list',
  result: {
    workspaces: [
      // The repo's own window comes first in the sidebar; its linked worktree sits under it even
      // though herdr numbered it much later.
      // The same repo reported two ways: the extended \\?\ path and the plain one. They must group.
      { workspace_id: 'w7Y', number: 2, label: 'pricing', focused: true, worktree: { repo_key: '\\\\?\\C:\\p\\pricing\\.git', repo_name: 'pricing', is_linked_worktree: false } },
      { workspace_id: 'w85', number: 40, label: 'news digest', focused: false, worktree: { repo_key: 'C:\\P\\pricing\\.git', repo_name: 'pricing', is_linked_worktree: true } },
    ],
  },
});

const herdr = (panes = PANE_LIST): HerdrRunner => async (args) =>
  ({ code: 0, stdout: args[0] === 'workspace' ? WORKSPACE_LIST : panes, stderr: '' });

function session(over: Partial<WorkSession>): WorkSession {
  return {
    provider: 'claude', id: 'sid', title: null, accountId: 'cc1', accountLabel: 'cc1 home', launcher: 'cc1',
    availableLaunchers: [], project: 'p', folder: 'p', cwd: 'C:\\Users\\<user>\\projects\\p', branch: null,
    lastActivity: '2026-09-23T09:00:00.000Z', activity: 'idle', pid: null, resumeCommand: '', ...over,
  };
}

function sessionsResponse(sessions: WorkSession[]): SessionsResponse {
  return { windows: [], sessions, generatedAt: '2026-09-23T10:00:00.000Z', recentHours: 24, partial: false, warnings: [] };
}

test('parsePanes reads the herdr envelope and keeps only the fields the page needs', () => {
  const panes = parsePanes(`banner line\n${PANE_LIST}\n`);
  assert.equal(panes.length, 3);
  assert.equal(panes[0]!.paneId, 'w85:p1');
  assert.equal(panes[0]!.sessionId, 'sid-news');
  assert.equal(panes[0]!.title, 'News digest');
  assert.equal(panes[1]!.agentStatus, 'working');
});

test('parsePanes returns nothing rather than throwing on junk', () => {
  assert.deepEqual(parsePanes('herdr: command not found'), []);
  assert.deepEqual(parsePanes('{"id":"cli:pane:list"} trailing garbage {'), []);
});

// PowerShell's ConvertTo-Json collapses a single row to an object and Set-Content -Encoding UTF8
// writes a BOM; both come straight from ccmode, so both must parse.
test('parseMarks accepts a BOM and a single-object file', () => {
  const one = parseMarks('\uFEFF' + JSON.stringify({ cwd: 'C:\\p\\a\\', pane: 'w1:p1', mode: 'off', set: '2026-09-23 10:00' }));
  assert.deepEqual(one, [{ cwd: 'C:\\p\\a', pane: 'w1:p1', mode: 'off', set: '2026-09-23 10:00' }]);
  assert.deepEqual(parseMarks('not json'), []);
  assert.deepEqual(parseMarks(JSON.stringify([{ cwd: 'x', mode: 'nonsense' }])), []);
});

test('applyMode replaces this pane only and auto just removes the mark', () => {
  const now = new Date('2026-09-23T13:45:00');
  const marks: ModeMark[] = [
    { cwd: 'C:\\p\\a', pane: 'w1:p1', mode: 'ever', set: '2026-09-01 10:00' },
    { cwd: 'C:\\p\\b', pane: 'w2:p1', mode: 'warm', set: '2026-09-01 10:00' },
  ];
  const off = applyMode(marks, { pane: 'w1:p1', cwd: 'C:\\p\\a', mode: 'off', now });
  assert.equal(off.length, 2);
  assert.deepEqual(off.find((m) => m.pane === 'w1:p1'), { cwd: 'C:\\p\\a', pane: 'w1:p1', mode: 'off', set: stamp(now) });
  assert.equal(off.find((m) => m.pane === 'w2:p1')?.mode, 'warm');

  const cleared = applyMode(off, { pane: 'w1:p1', cwd: 'C:\\p\\a', mode: 'auto', now });
  assert.deepEqual(cleared.map((m) => m.pane), ['w2:p1']);
});

test('a folder-wide mark is only replaced by another folder-wide mark', () => {
  const now = new Date('2026-09-23T13:45:00');
  const marks: ModeMark[] = [{ cwd: 'C:\\p\\a', pane: null, mode: 'off', set: '2026-09-01 10:00' }];
  // Marking one pane of that folder must not wipe the folder-wide row.
  const pinned = applyMode(marks, { pane: 'w1:p1', cwd: 'C:\\p\\a', mode: 'warm', now });
  assert.equal(pinned.length, 2);
  assert.equal(applyMode(marks, { pane: null, cwd: 'C:\\p\\a\\', mode: 'auto', now }).length, 0);
});

test('markFor prefers an exact pane mark over the folder-wide one', () => {
  const marks: ModeMark[] = [
    { cwd: 'C:\\p\\a', pane: null, mode: 'off', set: '' },
    { cwd: 'C:\\p\\a', pane: 'w1:p1', mode: 'ever', set: '' },
  ];
  assert.deepEqual(markFor(marks, 'w1:p1', 'C:\\p\\a')?.scope, 'pane');
  assert.equal(markFor(marks, 'w1:p1', 'C:\\p\\a')?.mark.mode, 'ever');
  assert.equal(markFor(marks, 'w9:p9', 'C:\\p\\a')?.scope, 'folder');
  assert.equal(markFor(marks, 'w9:p9', 'C:\\p\\zzz'), null);
});

test('verdict mirrors the watchdog rules, marked-off first', () => {
  assert.equal(verdict({ mode: 'off', agentStatus: 'idle', idleMinutes: 300, blockedReason: null }).compactable, false);
  assert.equal(verdict({ mode: null, agentStatus: 'working', idleMinutes: 300, blockedReason: null }).compactable, false);
  assert.equal(verdict({ mode: null, agentStatus: 'idle', idleMinutes: null, blockedReason: null }).compactable, false);
  assert.equal(verdict({ mode: null, agentStatus: 'idle', idleMinutes: 300, blockedReason: 'limit spent' }).compactable, false);
  assert.equal(verdict({ mode: null, agentStatus: 'idle', idleMinutes: 20, blockedReason: null }).compactable, false);
  assert.equal(verdict({ mode: null, agentStatus: 'idle', idleMinutes: 2000, blockedReason: null }).compactable, false);
  assert.equal(verdict({ mode: 'warm', agentStatus: 'idle', idleMinutes: 300, blockedReason: null }).compactable, true);
});

test('getFleet joins herdr panes with subtrack activity, marks and compaction history', async () => {
  await withTempBase(async (base) => {
    await mkdir(join(base, '.claude', 'idle-compact'), { recursive: true });
    await writeFile(join(base, '.claude', 'idle-compact', 'state.json'),
      JSON.stringify({ 'sid-news': { at: '2026-09-23T09:16:03', failed: true } }), 'utf8');
    await writeMarks(base, [{ cwd: 'C:\\Users\\<user>\\projects\\news', pane: 'w85:p1', mode: 'off', set: '2026-09-23 09:00' }]);

    const run = herdr();
    const getFleet = makeGetFleet({
      base,
      run,
      now: () => Date.parse('2026-09-23T13:00:00.000Z'),
      getSessions: async () => sessionsResponse([
        session({ id: 'sid-news', folder: 'news', cwd: 'C:\\Users\\<user>\\projects\\news', lastActivity: '2026-09-23T06:11:53.218Z', accountId: 'cc2', accountLabel: 'cc2' }),
        // The pane's own record has no home; the live window of the same folder supplies it.
        session({ id: 'sid-pricing', folder: 'pricing', cwd: 'C:\\Users\\<user>\\projects\\pricing', accountId: 'claude-default', lastActivity: '2026-09-23T12:50:00.000Z' }),
        session({ id: 'other', folder: 'pricing', cwd: 'C:\\Users\\<user>\\projects\\pricing', accountId: 'cc5', accountLabel: 'cc5', pid: 42 }),
      ]),
      blockedAccounts: () => new Map([['cc9', 'limit spent']]),
    });

    const res = await getFleet();
    assert.deepEqual(res.warnings, []);
    assert.equal(res.windows.length, 2, 'the codex pane is not ours');
    const news = res.windows.find((w) => w.paneId === 'w85:p1')!;
    assert.equal(news.mode, 'off');
    assert.equal(news.markScope, 'pane');
    assert.equal(news.idleMinutes, 408);
    assert.equal(news.compactable, false);
    assert.match(news.reason, /marked off/);
    assert.equal(news.lastCompactFailed, true);
    const pricing = res.windows.find((w) => w.paneId === 'w7Y:p2')!;
    assert.equal(pricing.accountId, 'cc5', 'claude-default filled in from the live window of that folder');
    assert.equal(pricing.compactable, false);
    assert.equal(pricing.reason, 'working');
    // herdr's own order: the repo's window, then its worktree nested under it — not our idle sort.
    assert.deepEqual(res.windows.map((w) => w.paneId), ['w7Y:p2', 'w85:p1']);
    assert.equal(pricing.depth, 0);
    assert.equal(pricing.workspaceLabel, 'pricing');
    assert.equal(news.depth, 1, 'a linked worktree hangs under the repo it belongs to');
    assert.equal(news.isWorktree, true);
    assert.equal(news.repoName, 'pricing');
    assert.equal(news.workspaceNumber, 40);
  });
});

test('getFleet degrades to a warning when herdr cannot be reached', async () => {
  await withTempBase(async (base) => {
    const getFleet = makeGetFleet({ base, run: async () => ({ code: 1, stdout: '', stderr: 'ENOENT' }), getSessions: async () => sessionsResponse([]) });
    const res = await getFleet();
    assert.deepEqual(res.windows, []);
    assert.equal(res.warnings.length, 1);
    assert.match(res.warnings[0]!, /herdr pane list failed/);
  });
});

test('setWindowMode writes the shared marks file as an array ccmode can read back', async () => {
  await withTempBase(async (base) => {
    const set = makeSetWindowMode({ base, now: () => Date.parse('2026-09-23T13:45:00') });
    await set({ pane: 'w85:p1', cwd: 'C:\\Users\\<user>\\projects\\news\\', mode: 'off' });
    const raw = await readFile(modesPath(base), 'utf8');
    assert.equal(raw.startsWith('['), true, 'never PowerShell\'s single-object collapse');
    assert.equal(raw.charCodeAt(0) !== 0xfeff, true, 'no BOM');
    assert.deepEqual(await readMarks(base), [{ cwd: 'C:\\Users\\<user>\\projects\\news', pane: 'w85:p1', mode: 'off', set: '2026-09-23 13:45' }]);

    await set({ pane: 'w85:p1', cwd: 'C:\\Users\\<user>\\projects\\news', mode: 'auto' });
    assert.deepEqual(await readMarks(base), []);
  });
});

test('setWindowMode refuses an unknown mode and a window it cannot identify', async () => {
  await withTempBase(async (base) => {
    const set = makeSetWindowMode({ base });
    await assert.rejects(() => set({ pane: 'w1:p1', cwd: 'C:\\p', mode: 'sleep' as 'off' }), /mode must be/);
    await assert.rejects(() => set({ pane: null, cwd: '', mode: 'off' }), /pane or cwd required/);
  });
});
