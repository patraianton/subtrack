import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexHomeDir, readCodexAuth, buildCodexLogin } from '../../src/auth/codex.ts';

test('codexHomeDir builds isolated path', () => {
  assert.equal(codexHomeDir('/base', 'codex-main'), join('/base', 'codex-homes', 'codex-main'));
});

test('buildCodexLogin sets CODEX_HOME env', () => {
  const spec = buildCodexLogin('/base/codex-homes/codex-main');
  assert.equal(spec.cmd, 'codex');
  assert.deepEqual(spec.args, ['login']);
  assert.equal(spec.env.CODEX_HOME, '/base/codex-homes/codex-main');
});

test('readCodexAuth extracts access_token + account_id', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codexhome-'));
  try {
    await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'at', account_id: 'acct_1', refresh_token: 'rt' } }), 'utf8');
    const out = await readCodexAuth(home);
    assert.equal(out.accessToken, 'at');
    assert.equal(out.accountId, 'acct_1');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('readCodexAuth throws when access_token missing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codexhome-'));
  try {
    await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: {} }), 'utf8');
    await assert.rejects(() => readCodexAuth(home), /codex login/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
