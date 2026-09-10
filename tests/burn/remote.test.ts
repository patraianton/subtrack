import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRemoteScanner, scanRemoteHost, type RemoteRunner } from '../../src/burn/remote.ts';

function answer(rows: unknown[], extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ rows, shared: [], warnings: [], ...extra })}\n`;
}

const ROW = {
  accountId: 'acct-a', sessionId: 'sess-1', cwd: '/Users/anton/kitchens/lane-1',
  models: { 'gpt-6-astra': 3 }, replies: 12,
  input: 100, cacheWrite: 0, cacheRead: 900, output: 40,
  firstMs: 1_700_000_000_000, lastMs: 1_700_000_600_000,
};

test('reads the summed rows a host returns and ignores anything printed before them', async () => {
  // ssh likes to add banners and warnings of its own; the payload is the last line.
  const run: RemoteRunner = async () => `Warning: Permanently added 'mac' to known hosts.\n${answer([ROW])}`;
  const scan = await scanRemoteHost('mac', 1, 2, run);
  assert.equal(scan.rows.length, 1);
  assert.equal(scan.rows[0]!.sessionId, 'sess-1');
  assert.equal(scan.rows[0]!.cacheRead, 900);
  assert.deepEqual(scan.rows[0]!.models, { 'gpt-6-astra': 3 });
});

test('passes the window to the host and refuses an answer that is not JSON', async () => {
  let seen: string[] = [];
  const run: RemoteRunner = async (_host, _script, args) => { seen = args; return answer([]); };
  await scanRemoteHost('mac', 1_500.4, 2_500.6, run);
  assert.deepEqual(seen, ['1500', '2501']);

  const broken: RemoteRunner = async () => 'python3: command not found';
  await assert.rejects(() => scanRemoteHost('mac', 1, 2, broken), /not JSON/);
});

test('drops rows that do not identify an account or session instead of inventing ids', async () => {
  const run: RemoteRunner = async () => answer([ROW, { ...ROW, accountId: 42 }, { sessionId: 'x' }]);
  const scan = await scanRemoteHost('mac', 1, 2, run);
  assert.deepEqual(scan.rows.map((row) => row.sessionId), ['sess-1']);
});

test('scans a host once per window, and never caches a failure', async () => {
  let calls = 0;
  let fail = true;
  const run: RemoteRunner = async () => { calls += 1; if (fail) throw new Error('host is asleep'); return answer([ROW]); };
  let now = 1_000;
  const scan = makeRemoteScanner(run, 30_000, () => now);

  await assert.rejects(() => scan('mac', 100, 200), /asleep/);
  await assert.rejects(() => scan('mac', 100, 200), /asleep/);
  assert.equal(calls, 2, 'a failed trip must be retried, not remembered');

  fail = false;
  await scan('mac', 100, 200);
  await scan('mac', 100, 200);          // same window: served from cache
  assert.equal(calls, 3);
  await scan('mac', 999, 1_099);        // the provider rolled the window: a new scan
  assert.equal(calls, 4);
  now += 31_000;
  await scan('mac', 100, 200);          // cache expired
  assert.equal(calls, 5);
});
