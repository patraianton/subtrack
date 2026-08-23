import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildResumeCommand, scanSessions } from '../../src/sessions/scan.ts';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');

async function withTempBase(fn: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-sessions-'));
  try { await fn(base); } finally { await rm(base, { recursive: true, force: true }); }
}

async function writeTranscript(
  home: string,
  projectKey: string,
  id: string,
  rows: object[],
  mtime?: string,
): Promise<string> {
  const dir = join(home, 'projects', projectKey);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  if (mtime) {
    const when = new Date(mtime);
    await utimes(path, when, when);
  }
  return path;
}

test('Claude scan reads direct transcripts, excludes nested subagents, and trusts transcript time over mtime', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.claude');
    const cwd = join(base, 'projects', 'alpha');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const id = '11111111-1111-4111-8111-111111111111';
    await writeTranscript(home, 'encoded-alpha', id, [
      { type: 'user', cwd, sessionId: id, timestamp: '2026-07-15T09:00:00.000Z', gitBranch: 'main' },
      { type: 'custom-title', customTitle: '  Alpha   planning  ', cwd, timestamp: '2026-07-15T09:30:00.000Z' },
    ], '2026-07-15T11:45:00.000Z');

    const nestedId = '22222222-2222-4222-8222-222222222222';
    const nestedDir = join(home, 'projects', 'encoded-alpha', id, 'subagents');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, `${nestedId}.jsonl`), `${JSON.stringify({ cwd, sessionId: nestedId, timestamp: '2026-07-15T11:00:00.000Z' })}\n`);

    const result = await scanSessions({ base, now: () => NOW, getLiveWindows: async () => [] });

    assert.equal(result.partial, false);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.id, id);
    assert.equal(result.sessions[0]!.title, 'Alpha planning');
    assert.equal(result.sessions[0]!.cwd, cwd);
    assert.equal(result.sessions[0]!.project, 'alpha');
    assert.equal(result.sessions[0]!.branch, 'main');
    assert.equal(result.sessions[0]!.lastActivity, '2026-07-15T09:30:00.000Z');
    assert.ok(!result.sessions.some((session) => session.id === nestedId));
  });
});

test('duplicate Claude transcript copies collapse to one logical session and retain launchers', async () => {
  await withTempBase(async (base) => {
    const defaultHome = join(base, '.claude');
    const accountHome = join(base, '.claude-accounts', '1-alpha');
    const cwd = join(base, 'work', 'duplicate-project');
    await mkdir(cwd, { recursive: true });
    const id = '33333333-3333-4333-8333-333333333333';
    await writeTranscript(defaultHome, 'project', id, [
      { cwd, sessionId: id, aiTitle: 'Older copy', timestamp: '2026-07-15T08:00:00.000Z' },
    ], '2026-07-15T08:00:00.000Z');
    await writeTranscript(accountHome, 'project', id, [
      { cwd, sessionId: id, aiTitle: 'Newest copy', timestamp: '2026-07-15T10:00:00.000Z' },
    ], '2026-07-15T10:00:00.000Z');

    const result = await scanSessions({ base, now: () => NOW, getLiveWindows: async () => [] });

    assert.equal(result.sessions.length, 1);
    const session = result.sessions[0]!;
    assert.equal(session.id, id);
    assert.equal(session.title, 'Newest copy');
    assert.equal(session.launcher, 'cc1');
    assert.deepEqual(session.availableLaunchers, ['cc1', 'ccdefault']);
    assert.match(session.resumeCommand, /cc1 --resume/);
  });
});

test('account homes whose projects is a junction to the default store collapse to one physical store', async () => {
  await withTempBase(async (base) => {
    const defaultHome = join(base, '.claude');
    const accountHome = join(base, '.claude-accounts', '1-alpha');
    const cwd = join(base, 'work', 'shared-project');
    await mkdir(cwd, { recursive: true });
    const id = '55555555-5555-4555-8555-555555555555';
    await writeTranscript(defaultHome, 'shared', id, [
      { cwd, sessionId: id, aiTitle: 'Shared store', timestamp: '2026-07-15T10:00:00.000Z' },
    ], '2026-07-15T10:00:00.000Z');
    await mkdir(accountHome, { recursive: true });
    await symlink(join(defaultHome, 'projects'), join(accountHome, 'projects'), 'junction');

    const result = await scanSessions({ base, now: () => NOW, getLiveWindows: async () => [] });

    assert.equal(result.partial, false);
    assert.equal(result.sessions.length, 1);
    const session = result.sessions[0]!;
    assert.equal(session.id, id);
    // one physical store -> one launcher attribution, owned by the physical home
    assert.equal(session.launcher, 'ccdefault');
    assert.deepEqual(session.availableLaunchers, ['ccdefault']);
  });
});

test('live Claude windows distinguish likely transcript correlation from an unknown fresh window', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.claude');
    const cwd = join(base, 'work', 'live-project');
    const unknownCwd = join(base, 'work', 'empty-project');
    await mkdir(cwd, { recursive: true });
    await mkdir(unknownCwd, { recursive: true });
    const id = '44444444-4444-4444-8444-444444444444';
    await writeTranscript(home, 'live', id, [
      { cwd, sessionId: id, customTitle: 'Live work', timestamp: '2026-07-15T10:03:00.000Z' },
    ], '2026-07-15T10:03:00.000Z');

    const result = await scanSessions({
      base,
      now: () => NOW,
      getLiveWindows: async () => [
        { pid: 101, startedAt: '2026-07-15T10:02:00.000Z', configDir: home, cwd: `${cwd}\\`, launchSessionId: null },
        { pid: 102, startedAt: '2026-07-15T10:04:00.000Z', configDir: home, cwd: unknownCwd, launchSessionId: null },
      ],
    });

    const likely = result.windows.find((window) => window.pid === 101)!;
    assert.equal(likely.binding, 'likely');
    assert.equal(likely.sessionId, id);
    assert.equal(likely.cwd, cwd);
    assert.equal(likely.title, 'Live work');
    assert.match(likely.resumeCommand!, /ccdefault --resume/);
    assert.equal(result.sessions[0]!.activity, 'open');
    assert.equal(result.sessions[0]!.pid, 101);

    const unknown = result.windows.find((window) => window.pid === 102)!;
    assert.equal(unknown.binding, 'unknown');
    assert.equal(unknown.sessionId, null);
    assert.equal(unknown.resumeCommand, null);
  });
});

test('resume commands quote PowerShell paths and ids without interpolation', () => {
  assert.equal(
    buildResumeCommand('claude', 'cc3', '', `C:\\work\\O'Brien`, `id'part`),
    `Set-Location -LiteralPath 'C:\\work\\O''Brien'; cc3 --resume 'id''part'`,
  );
  assert.equal(
    buildResumeCommand('codex', 'codex', `C:\\Users\\O'Brien\\.codex`, `C:\\work\\A project's`, `thread'id`),
    `$env:CODEX_HOME='C:\\Users\\O''Brien\\.codex'; codex resume -C 'C:\\work\\A project''s' 'thread''id'`,
  );
  assert.equal(
    buildResumeCommand('claude', 'claude', `C:\\external\\O'Brien`, `C:\\work\\project`, 'session-id'),
    `$env:CLAUDE_CONFIG_DIR='C:\\external\\O''Brien'; Set-Location -LiteralPath 'C:\\work\\project'; claude --resume 'session-id'`,
  );
});

test('Claude worktrees keep the repository name in the project label', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.claude');
    const repo = join(base, 'business-ideas');
    const cwd = join(repo, '.claude', 'worktrees', 'ukraine', 'research');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });
    const id = '55555555-5555-4555-8555-555555555555';
    await writeTranscript(home, 'worktree', id, [
      { cwd, sessionId: id, timestamp: '2026-07-15T11:00:00.000Z' },
    ]);

    const result = await scanSessions({ base, now: () => NOW, getLiveWindows: async () => [] });

    assert.equal(result.sessions[0]!.project, 'business-ideas · ukraine');
    assert.equal(result.sessions[0]!.folder, 'research');
  });
});

test('owned Claude usage homes are never inventoried as interactive resume targets', async () => {
  await withTempBase(async (base) => {
    const ownedHome = join(base, '.subtrack', 'claude-homes', 'usage-only');
    const cwd = join(base, 'work', 'probe');
    await mkdir(cwd, { recursive: true });
    const id = '66666666-6666-4666-8666-666666666666';
    await writeTranscript(ownedHome, 'probe', id, [
      { cwd, sessionId: id, timestamp: '2026-07-15T11:00:00.000Z' },
    ]);
    const account = {
      id: 'claude-usage', label: 'Usage only', provider: 'claude' as const, enabled: true,
      credentialsHome: ownedHome,
    };

    const owned = await scanSessions({ base, accounts: [account], now: () => NOW, getLiveWindows: async () => [] });
    assert.equal(owned.sessions.length, 0);

    const readonly = await scanSessions({
      base,
      accounts: [{ ...account, credentialsMode: 'readonly' }],
      now: () => NOW,
      getLiveWindows: async () => [],
    });
    assert.equal(readonly.sessions.length, 1);
    assert.match(readonly.sessions[0]!.resumeCommand, /CLAUDE_CONFIG_DIR/);
  });
});
