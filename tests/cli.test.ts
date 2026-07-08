import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseArgs, formatCheckTable, main, registerStaticTokenAccount } from '../src/cli.ts';
import type { NormalizedUsage, SubtrackConfig } from '../src/types.ts';

async function withTmp(prefix: string, fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function readCfg(base: string): Promise<SubtrackConfig> {
  return JSON.parse(await readFile(join(base, '.subtrack', 'accounts.json'), 'utf8')) as SubtrackConfig;
}

function silenced<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  return fn().finally(() => { console.log = log; console.error = err; });
}

test('parseArgs splits command, positionals, and flags', () => {
  const r = parseArgs(['add-account', 'claude-1', '--provider', 'claude', '--label', 'Work A', '--enabled']);
  assert.equal(r.cmd, 'add-account');
  assert.deepEqual(r.positionals, ['claude-1']);
  assert.equal(r.flags.provider, 'claude');
  assert.equal(r.flags.label, 'Work A');
  assert.equal(r.flags.enabled, true);
});

test('parseArgs defaults cmd to empty when none given', () => {
  assert.equal(parseArgs([]).cmd, '');
});

test('formatCheckTable renders one row per account with percentages', () => {
  const usages: NormalizedUsage[] = [
    { accountId: 'c1', label: 'Claude 1', provider: 'claude',
      session: { utilization: 62, resetsAt: '2026-06-29T17:40:00.000Z' },
      weekly: { utilization: 41, resetsAt: '2026-07-02T09:00:00.000Z' },
      weeklyOpus: null, fable: { utilization: 88, resetsAt: '2026-07-02T09:00:00.000Z' }, fableAccess: true,
      status: 'ok', lastUpdated: '2026-06-29T12:00:00.000Z', error: null, retryAt: null },
    { accountId: 'x1', label: 'Codex 1', provider: 'codex',
      session: null, weekly: null, weeklyOpus: null, fable: null, fableAccess: false,
      status: 'auth_error', lastUpdated: '2026-06-29T12:00:00.000Z', error: 'expired', retryAt: null },
  ];
  const table = formatCheckTable(usages);
  assert.match(table, /Claude 1/);
  assert.match(table, /62%/);
  assert.match(table, /41%/);
  assert.match(table, /88%/);   // fable column
  assert.match(table, /FABLE/);
  assert.match(table, /auth_error/);
});

test('add-account --readonly-home registers an external CLI home without login, mode readonly', async () => {
  await withTmp('subtrack-cli-', async (base) => {
    await withTmp('ext-cli-home-', async (extHome) => {
      await writeFile(join(extHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'cli-tok', refreshToken: 'cli-r', expiresAt: 9 } }), 'utf8');
      await writeFile(join(extHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'cc4@example.com' } }), 'utf8');
      const before = await readFile(join(extHome, '.credentials.json'), 'utf8');
      const code = await silenced(() => main(['add-account', 'cc4', '--provider', 'claude', '--readonly-home', extHome], base));
      assert.equal(code, 0);
      const acc = (await readCfg(base)).accounts.find((a) => a.id === 'cc4');
      assert.equal(acc?.credentialsMode, 'readonly');
      assert.equal(acc?.credentialsHome, extHome);
      assert.equal(acc?.label, 'cc4@example.com'); // label defaults to the home's account email
      assert.equal(await readFile(join(extHome, '.credentials.json'), 'utf8'), before); // never written
    });
  });
});

test('add-account --readonly-home fails cleanly when the home has no credentials', async () => {
  await withTmp('subtrack-cli-', async (base) => {
    await withTmp('ext-cli-home-', async (extHome) => {
      const code = await silenced(() => main(['add-account', 'cc4', '--provider', 'claude', '--readonly-home', extHome], base));
      assert.equal(code, 2);
    });
  });
});

test('registerStaticTokenAccount stores a refresh-less setup-token and registers the account readonly', async () => {
  await withTmp('subtrack-cli-', async (base) => {
    const code = await silenced(() => registerStaticTokenAccount(base, 'cc9', 'sk-ant-oat01-STATIC', 'static acct'));
    assert.equal(code, 0);
    const acc = (await readCfg(base)).accounts.find((a) => a.id === 'cc9');
    assert.equal(acc?.credentialsMode, 'readonly');
    assert.equal(acc?.label, 'static acct');
    const file = JSON.parse(await readFile(join(acc!.credentialsHome!, '.credentials.json'), 'utf8')) as { claudeAiOauth: Record<string, unknown> };
    assert.equal(file.claudeAiOauth.accessToken, 'sk-ant-oat01-STATIC');
    assert.equal('refreshToken' in file.claudeAiOauth, false); // nothing to rotate, ever
    assert.equal('expiresAt' in file.claudeAiOauth, false);    // long-lived: no fake expiry
  });
});

test('main resolves to exit 1 (never an unhandled rejection) when accounts.json is corrupt', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-'));
  const origError = console.error;
  console.error = () => {}; // silence the expected one-line error message during the test
  try {
    await mkdir(join(base, '.subtrack'), { recursive: true });
    await writeFile(join(base, '.subtrack', 'accounts.json'), '{ not valid json', 'utf8');
    // `status` loads config first; a corrupt file must resolve to 1, not throw past main().
    assert.equal(await main(['status'], base), 1);
  } finally {
    console.error = origError;
    await rm(base, { recursive: true, force: true });
  }
});
