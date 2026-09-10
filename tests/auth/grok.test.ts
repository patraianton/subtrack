import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grokHomeDir, grokCookiePath, readGrokCookie, readGrokMeta, writeGrokMeta } from '../../src/auth/grok.ts';

async function withTmp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'subtrack-grok-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('grokHomeDir places isolated homes under grok-homes/<id>', () => {
  assert.equal(grokHomeDir(join('base'), 'g1'), join('base', 'grok-homes', 'g1'));
});

test('readGrokCookie throws an actionable error when cookie.txt is missing', async () => {
  await withTmp(async (home) => {
    await assert.rejects(() => readGrokCookie(home), (e: Error) => {
      assert.match(e.message, /cookie/i);
      assert.ok(e.message.includes(grokCookiePath(home)));
      return true;
    });
  });
});

test('readGrokCookie throws when cookie.txt is empty', async () => {
  await withTmp(async (home) => {
    await writeFile(grokCookiePath(home), '   \r\n', 'utf8');
    await assert.rejects(() => readGrokCookie(home), /empty/i);
  });
});

test('readGrokCookie strips BOM, a pasted "Cookie:" prefix, and surrounding whitespace', async () => {
  await withTmp(async (home) => {
    await writeFile(grokCookiePath(home), '﻿Cookie: sso=abc; sso-rw=def\r\n', 'utf8');
    assert.equal(await readGrokCookie(home), 'sso=abc; sso-rw=def');
  });
});

test('readGrokCookie joins accidental line wraps into one header value', async () => {
  await withTmp(async (home) => {
    await writeFile(grokCookiePath(home), 'sso=abc;\nsso-rw=def', 'utf8');
    assert.equal(await readGrokCookie(home), 'sso=abc; sso-rw=def');
  });
});

test('readGrokCookie decodes a UTF-16LE cookie.txt (PowerShell 5.1 Out-File default)', async () => {
  await withTmp(async (home) => {
    await writeFile(grokCookiePath(home), Buffer.from('﻿sso=abc; sso-rw=def\r\n', 'utf16le'));
    assert.equal(await readGrokCookie(home), 'sso=abc; sso-rw=def');
  });
});

test('grok meta round-trips the account email', async () => {
  await withTmp(async (home) => {
    assert.deepEqual(await readGrokMeta(home), {});
    await writeGrokMeta(home, { email: 'tools@example.com' });
    assert.deepEqual(await readGrokMeta(home), { email: 'tools@example.com' });
  });
});
