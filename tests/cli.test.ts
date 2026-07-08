import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, formatCheckTable, main } from '../src/cli.ts';
import type { NormalizedUsage } from '../src/types.ts';

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
