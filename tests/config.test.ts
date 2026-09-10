import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, saveConfig, addAccount, removeAccount, renameAccount } from '../src/config.ts';
import type { AccountConfig } from '../src/types.ts';

test('renameAccount changes only the matching account label', () => {
  const a: AccountConfig = { id: 'a', label: 'A', provider: 'claude', enabled: true };
  const b: AccountConfig = { id: 'b', label: 'B', provider: 'codex', enabled: true };
  const cfg = addAccount(addAccount({ ...DEFAULT_CONFIG }, a), b);
  const after = renameAccount(cfg, 'a', 'Work — Acme');
  assert.equal(after.accounts.find((x) => x.id === 'a')?.label, 'Work — Acme');
  assert.equal(after.accounts.find((x) => x.id === 'b')?.label, 'B'); // untouched
});

async function withTempBase(fn: (base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-'));
  try { await fn(base); } finally { await rm(base, { recursive: true, force: true }); }
}

test('loadConfig returns defaults when file is missing', async () => {
  await withTempBase(async (base) => {
    const cfg = await loadConfig(base);
    assert.deepEqual(cfg.accounts, []);
    assert.equal(cfg.port, DEFAULT_CONFIG.port);
    assert.equal(cfg.pollIntervalSeconds.claude, 180);
  });
});

test('saveConfig then loadConfig round-trips accounts', async () => {
  await withTempBase(async (base) => {
    const acc: AccountConfig = { id: 'c1', label: 'C1', provider: 'claude', enabled: true, credentialsHome: '/home/c1' };
    await saveConfig(addAccount({ ...DEFAULT_CONFIG }, acc), base);
    const cfg = await loadConfig(base);
    assert.equal(cfg.accounts.length, 1);
    assert.equal(cfg.accounts[0]!.id, 'c1');
  });
});

test('addAccount rejects duplicate id', () => {
  const acc: AccountConfig = { id: 'c1', label: 'C1', provider: 'claude', enabled: true };
  const cfg = addAccount({ ...DEFAULT_CONFIG }, acc);
  assert.throws(() => addAccount(cfg, acc), /already exists/);
});

test('removeAccount drops the matching id', () => {
  const a: AccountConfig = { id: 'a', label: 'A', provider: 'claude', enabled: true };
  const b: AccountConfig = { id: 'b', label: 'B', provider: 'codex', enabled: true };
  const cfg = addAccount(addAccount({ ...DEFAULT_CONFIG }, a), b);
  const after = removeAccount(cfg, 'a');
  assert.deepEqual(after.accounts.map((x) => x.id), ['b']);
});

test('loadConfig deep-merges partial pollIntervalSeconds, preserving defaults for missing keys', async () => {
  await withTempBase(async (base) => {
    const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('node:fs/promises');
    const { configDir, configPath } = await import('../src/config.ts');
    await mkdirFs(configDir(base), { recursive: true });
    await writeFileFs(configPath(base), JSON.stringify({ version: 1, pollIntervalSeconds: { claude: 300 } }), 'utf8');
    const cfg = await loadConfig(base);
    assert.equal(cfg.pollIntervalSeconds.claude, 300);
    assert.equal(cfg.pollIntervalSeconds.codex, 60);
    assert.equal(cfg.pollIntervalSeconds.grok, 60); // filled in for configs written before the provider existed
  });
});
