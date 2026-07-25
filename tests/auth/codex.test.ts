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

test('readCodexAuth reads an externally-owned Hermes shared store without rewriting it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codexhome-hermes-'));
  try {
    const authPath = join(home, 'auth.json');
    const raw = JSON.stringify({ providers: { 'openai-codex': { account_id: 'acct_shared', tokens: { access_token: 'shared-at', refresh_token: 'shared-rt' } } } });
    await writeFile(authPath, raw, 'utf8');
    const out = await readCodexAuth(home);
    assert.deepEqual(out, { accessToken: 'shared-at', accountId: 'acct_shared' });
    assert.equal(await (await import('node:fs/promises')).readFile(authPath, 'utf8'), raw);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('readCodexAuth turns a missing file into an actionable login command', async () => {
  const home = await mkdtemp(join(tmpdir(), "codexhome-O'Brien-"));
  try {
    await assert.rejects(
      () => readCodexAuth(home),
      (error: Error) => error.message.includes('Codex login missing')
        && error.message.includes(`CODEX_HOME='${home.replace(/'/g, "''")}'`)
        && error.message.includes('codex login'),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('readCodexAuth never recommends codex login for an externally-owned Hermes home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codexhome-external-'));
  try {
    await assert.rejects(
      () => readCodexAuth(home, { externalOwner: true }),
      (error: Error) => /owning Hermes login/i.test(error.message) && !/run:.*codex login/i.test(error.message),
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});
