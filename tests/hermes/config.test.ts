import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hermesConfigPath, loadHermesConfig } from '../../src/hermes/config.ts';

test('missing hermes.json disables the optional monitor', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-hermes-config-'));
  try { assert.equal(await loadHermesConfig(base), null); }
  finally { await rm(base, { recursive: true, force: true }); }
});

test('loads, validates and clamps Hermes monitor policy', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-hermes-config-'));
  try {
    await mkdir(join(base, '.subtrack'), { recursive: true });
    await writeFile(hermesConfigPath(base), JSON.stringify({
      version: 1, profileRoot: 'C:\\profiles', hermesCommand: 'C:\\hermes.exe',
      checkIntervalSeconds: 1, restartAfterFailures: 1,
      subscriptions: [{ id: 'a', label: 'A', authFile: 'C:\\a\\auth.json', expectedAccountId: 'acct-a' }],
      profileOverrides: { taras: { subscriptionId: 'a', expectedPlatform: 'none' } },
    }), 'utf8');
    const config = await loadHermesConfig(base);
    assert.ok(config);
    assert.equal(config.checkIntervalSeconds, 30);
    assert.equal(config.restartAfterFailures, 2);
    assert.equal(config.authProbeSeconds, 300);
    assert.equal(config.profileOverrides.taras?.expectedPlatform, 'none');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('rejects an override that names an unknown subscription', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-hermes-config-'));
  try {
    await mkdir(join(base, '.subtrack'), { recursive: true });
    await writeFile(hermesConfigPath(base), JSON.stringify({
      version: 1, profileRoot: 'C:\\profiles', hermesCommand: 'C:\\hermes.exe',
      subscriptions: [{ id: 'a', label: 'A', authFile: 'C:\\a\\auth.json', expectedAccountId: 'acct-a' }],
      profileOverrides: { ostap: { subscriptionId: 'missing' } },
    }), 'utf8');
    await assert.rejects(() => loadHermesConfig(base), /subscriptionId is unknown/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('rejects duplicate canonical store paths or account pins', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-hermes-config-'));
  try {
    await mkdir(join(base, '.subtrack'), { recursive: true });
    await writeFile(hermesConfigPath(base), JSON.stringify({
      version: 1, profileRoot: 'C:\\profiles', hermesCommand: 'C:\\hermes.exe',
      subscriptions: [
        { id: 'a', label: 'A', authFile: 'C:\\shared\\auth.json', expectedAccountId: 'acct-a' },
        { id: 'b', label: 'B', authFile: 'c:/shared/auth.json', expectedAccountId: 'acct-b' },
      ],
    }), 'utf8');
    await assert.rejects(() => loadHermesConfig(base), /duplicate subscription authFile/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
