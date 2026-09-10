import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanCodexBurn } from '../../src/burn/codex.ts';
import { makeGetBurn } from '../../src/burn/scan.ts';
import type { RemoteBurnScan } from '../../src/burn/remote.ts';
import type { AccountConfig } from '../../src/types.ts';

const NOW = Date.parse('2026-09-05T11:00:00.000Z');
const RESETS_AT = '2026-09-05T13:00:00.000Z';   // window is 08:00 -> 13:00
const IN_WINDOW = '2026-09-05T09:00:00.000Z';
const BEFORE_WINDOW = '2026-09-05T06:00:00.000Z';

const ACCT_A = 'acct-aaaa-1111';
const ACCT_B = 'acct-bbbb-2222';

async function withTempBase(fn: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-codexburn-'));
  try { await fn(base); } finally { await rm(base, { recursive: true, force: true }); }
}

function account(id: string, home: string, extra: Partial<AccountConfig> = {}): AccountConfig {
  return { id, label: `${id} · test`, provider: 'codex', enabled: true, credentialsHome: home, credentialsMode: 'readonly', ...extra } as AccountConfig;
}

/** A Codex home is identified only by the ChatGPT account id inside its auth.json. */
async function login(home: string, accountId: string): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: accountId, access_token: 'x' } }), 'utf8');
}

/** Codex files rollouts under the LOCAL date of the record, which is what the scanner looks for. */
function dayParts(iso: string): [string, string, string] {
  const at = new Date(Date.parse(iso));
  return [String(at.getFullYear()), String(at.getMonth() + 1).padStart(2, '0'), String(at.getDate()).padStart(2, '0')];
}

function usage(input: number, cached: number, output: number, cacheWrite = 0): Record<string, number> {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, output_tokens: output, total_tokens: input + output };
}

interface RolloutOptions {
  /** Parent session id — subagent threads repeat it so their spend rolls into one row. */
  sessionId: string;
  threadId?: string;
  cwd?: string;
  model?: string;
  /** CLI 0.153 shape, one record per response. */
  records?: { at: string; usage: Record<string, number>; responseId?: string }[];
  /** CLI 0.147 shape, only token_count events carrying the per-turn delta. */
  counts?: { at: string; usage: Record<string, number> }[];
  mtime?: Date;
  day?: string;
}

async function rollout(home: string, options: RolloutOptions): Promise<string> {
  const thread = options.threadId ?? options.sessionId;
  const anchor = options.day ?? options.records?.[0]?.at ?? options.counts?.[0]?.at ?? IN_WINDOW;
  const [year, month, day] = dayParts(anchor);
  const dir = join(home, 'sessions', year, month, day);
  await mkdir(dir, { recursive: true });
  const lines: string[] = [
    JSON.stringify({ timestamp: anchor, type: 'session_meta', payload: { session_id: options.sessionId, id: thread, cwd: options.cwd ?? 'C:\\work\\demo', originator: 'codex_exec' } }),
    JSON.stringify({ timestamp: anchor, type: 'turn_context', payload: { model: options.model ?? 'gpt-5.6-sol', cwd: options.cwd ?? 'C:\\work\\demo' } }),
  ];
  for (const entry of options.records ?? []) {
    lines.push(JSON.stringify({ timestamp: entry.at, type: 'token_usage_record', payload: { thread_id: thread, session_id: options.sessionId, response_id: entry.responseId ?? `resp-${lines.length}`, usage: entry.usage } }));
  }
  for (const entry of options.counts ?? []) {
    lines.push(JSON.stringify({ timestamp: entry.at, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: entry.usage, total_token_usage: entry.usage } } }));
  }
  const path = join(dir, `rollout-${anchor.replace(/[:.]/g, '-')}-${thread}.jsonl`);
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  if (options.mtime) await utimes(path, options.mtime, options.mtime);
  return path;
}

test('attributes a store to the login that owns it, even when it is not the configured home', async () => {
  await withTempBase(async (base) => {
    // The card points at an auth mirror (this is what the real codex-1 card does) while the work
    // runs in a completely different home that happens to be signed into the same subscription.
    const mirror = join(base, '.subtrack', 'codex-homes', 'codex-1-mac-mirror');
    const worker = join(base, '.codex');
    await login(mirror, ACCT_A);
    await login(worker, ACCT_A);
    await rollout(worker, { sessionId: 'sess-1', cwd: 'C:\\work\\alpha', records: [{ at: IN_WINDOW, usage: usage(1000, 800, 40) }] });

    const result = await scanCodexBurn('codex-1', RESETS_AT, { base, accounts: [account('codex-1', mirror)], now: () => NOW });
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.id, 'sess-1');
    assert.equal(result.sessions[0]!.project, 'alpha');
    assert.equal(result.sessions[0]!.share, 100);
    // Codex reports one input figure that already contains the cached part; the row splits them.
    assert.equal(result.sessions[0]!.inputTokens, 200);
    assert.equal(result.sessions[0]!.cacheReadTokens, 800);
    assert.equal(result.sessions[0]!.outputTokens, 40);
    assert.equal(result.sessions[0]!.models[0], 'gpt-5.6-sol');
    assert.equal(result.sessions[0]!.contested, false);
    assert.equal(result.partial, false);
  });
});

test('rolls a subagent thread into its parent session', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.codex-homes', 'cx3');
    await login(home, ACCT_A);
    await rollout(home, { sessionId: 'sess-1', records: [{ at: IN_WINDOW, usage: usage(100, 0, 10), responseId: 'r1' }] });
    await rollout(home, { sessionId: 'sess-1', threadId: 'thread-sub', records: [{ at: IN_WINDOW, usage: usage(500, 0, 90), responseId: 'r2' }] });

    const result = await scanCodexBurn('codex-3', RESETS_AT, { base, accounts: [account('codex-3', home)], now: () => NOW });
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.replies, 2);
    assert.equal(result.sessions[0]!.inputTokens, 600);
    assert.equal(result.sessions[0]!.outputTokens, 100);
  });
});

test('prefers per-response records and falls back to token_count for the older CLI shape', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.codex-homes', 'cx3');
    await login(home, ACCT_A);
    // New shape: both record kinds are written, and summing both would double-count.
    await rollout(home, {
      sessionId: 'new-cli',
      records: [{ at: IN_WINDOW, usage: usage(1000, 0, 10), responseId: 'r1' }, { at: IN_WINDOW, usage: usage(1000, 0, 10), responseId: 'r1' }],
      counts: [{ at: IN_WINDOW, usage: usage(1000, 0, 10) }],
    });
    // Old shape: token_count only, whose per-turn deltas sum to the session total.
    await rollout(home, { sessionId: 'old-cli', counts: [{ at: IN_WINDOW, usage: usage(300, 0, 5) }, { at: IN_WINDOW, usage: usage(300, 0, 5) }] });

    const result = await scanCodexBurn('codex-3', RESETS_AT, { base, accounts: [account('codex-3', home)], now: () => NOW });
    const rows = new Map(result.sessions.map((session) => [session.id, session]));
    // One response recorded twice is one turn, and the token_count copy is not added on top.
    assert.equal(rows.get('new-cli')!.replies, 1);
    assert.equal(rows.get('new-cli')!.inputTokens, 1000);
    assert.equal(rows.get('old-cli')!.replies, 2);
    assert.equal(rows.get('old-cli')!.inputTokens, 600);
  });
});

test('ignores records and files outside the window', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.codex-homes', 'cx3');
    await login(home, ACCT_A);
    await rollout(home, { sessionId: 'inside', records: [{ at: IN_WINDOW, usage: usage(100, 0, 10) }, { at: BEFORE_WINDOW, usage: usage(9_000, 0, 900) }] });
    await rollout(home, { sessionId: 'stale', records: [{ at: BEFORE_WINDOW, usage: usage(5_000, 0, 500) }], mtime: new Date(Date.parse(BEFORE_WINDOW)) });

    const result = await scanCodexBurn('codex-3', RESETS_AT, { base, accounts: [account('codex-3', home)], now: () => NOW });
    assert.deepEqual(result.sessions.map((session) => session.id), ['inside']);
    assert.equal(result.sessions[0]!.replies, 1);
    assert.equal(result.sessions[0]!.inputTokens, 100);
  });
});

test('skips a session store shared by two logins instead of guessing, and counts other accounts', async () => {
  await withTempBase(async (base) => {
    const mine = join(base, '.codex-homes', 'cx3');
    const theirs = join(base, '.codex-homes', 'cx5');
    await login(mine, ACCT_A);
    await login(theirs, ACCT_B);
    await rollout(mine, { sessionId: 'mine-1', records: [{ at: IN_WINDOW, usage: usage(100, 0, 10) }] });
    await rollout(theirs, { sessionId: 'theirs-1', records: [{ at: IN_WINDOW, usage: usage(100, 0, 10) }] });

    // A third home shares one physical store with two different logins (the cx lanes junction
    // theirs together); nothing local can say which subscription paid for what is inside it.
    const sharedStore = join(base, 'shared-store');
    const homeA = join(base, '.subtrack', 'codex-homes', 'codex-3');
    const homeB = join(base, '.subtrack', 'codex-homes', 'codex-5');
    await login(homeA, ACCT_A);
    await login(homeB, ACCT_B);
    await rollout(sharedStore, { sessionId: 'ambiguous', records: [{ at: IN_WINDOW, usage: usage(999_999, 0, 99_999) }] });
    // Both homes point their `sessions` at that one directory, exactly as the cx launcher homes do.
    for (const home of [homeA, homeB]) {
      await symlink(join(sharedStore, 'sessions'), join(home, 'sessions'), 'junction');
    }

    const accounts = [account('codex-3', mine), account('codex-5', theirs)];
    const result = await scanCodexBurn('codex-3', RESETS_AT, { base, accounts, now: () => NOW });
    assert.deepEqual(result.sessions.map((session) => session.id), ['mine-1']);
    assert.equal(result.otherSessions, 1);   // the other login's own store, not the shared one
    assert.equal(result.partial, true);
    assert.match(result.warnings.join(' '), /shared by 2 logins/);
  });
});

test('says so plainly when the login has no local store and when it cannot be identified', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.subtrack', 'codex-homes', 'codex-2');
    await login(home, ACCT_A);
    const none = await scanCodexBurn('codex-2', RESETS_AT, { base, accounts: [account('codex-2', home)], now: () => NOW });
    assert.deepEqual(none.sessions, []);
    assert.match(none.warnings.join(' '), /No Codex session store/);

    const anonymous = join(base, 'no-login');
    await mkdir(anonymous, { recursive: true });
    const blind = await scanCodexBurn('codex-9', RESETS_AT, { base, accounts: [account('codex-9', anonymous)], now: () => NOW });
    assert.deepEqual(blind.sessions, []);
    assert.match(blind.warnings.join(' '), /No readable Codex login/);

    const missing = await scanCodexBurn('codex-nope', RESETS_AT, { base, accounts: [], now: () => NOW });
    assert.match(missing.warnings.join(' '), /Unknown account/);
  });
});

test('falls back to a rolling window when the provider reset is unknown', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.codex-homes', 'cx3');
    await login(home, ACCT_A);
    const recent = new Date(NOW - 60 * 60 * 1000).toISOString();
    await rollout(home, { sessionId: 'sess-1', records: [{ at: recent, usage: usage(100, 0, 10) }] });

    const result = await scanCodexBurn('codex-3', null, { base, accounts: [account('codex-3', home)], now: () => NOW });
    assert.equal(result.resetsAt, null);
    assert.equal(result.windowStart, new Date(NOW - 5 * 3_600_000).toISOString());
    assert.equal(result.sessions.length, 1);
  });
});

test('makeGetBurn routes a Codex account to the Codex scanner', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.codex-homes', 'cx3');
    await login(home, ACCT_A);
    await rollout(home, { sessionId: 'sess-1', cwd: 'C:\\work\\lane-1', records: [{ at: IN_WINDOW, usage: usage(100, 0, 10) }] });

    const getBurn = makeGetBurn({ base, accounts: [account('codex-3', home)], now: () => NOW, cacheMs: 30_000 });
    const result = await getBurn('codex-3', RESETS_AT);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.project, 'lane-1');
  });
});

test('merges sessions from the machines where Codex actually runs, and labels them', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.subtrack', 'codex-homes', 'codex-3');
    await login(home, ACCT_A);   // the card's login: no local store at all, which is the normal case
    const remote: RemoteBurnScan = {
      rows: [
        { accountId: ACCT_A, sessionId: 'mac-1', cwd: '/Users/anton/kitchens/lane-6', models: { 'gpt-6-astra': 2 }, replies: 30, input: 500, cacheWrite: 0, cacheRead: 9_000, output: 120, firstMs: Date.parse(IN_WINDOW), lastMs: Date.parse(IN_WINDOW) + 60_000 },
        { accountId: ACCT_B, sessionId: 'not-mine', cwd: '/Users/anton/kitchens/lane-2', models: {}, replies: 4, input: 10, cacheWrite: 0, cacheRead: 20, output: 5, firstMs: Date.parse(IN_WINDOW), lastMs: Date.parse(IN_WINDOW) },
      ],
      shared: [],
      warnings: [],
    };

    const result = await scanCodexBurn('codex-3', RESETS_AT, {
      base,
      accounts: [account('codex-3', home)],
      now: () => NOW,
      remotes: ['mac'],
      scanRemote: async () => remote,
    });
    assert.deepEqual(result.sessions.map((session) => session.id), ['mac-1']);
    assert.equal(result.sessions[0]!.host, 'mac');
    assert.equal(result.sessions[0]!.project, 'lane-6');
    assert.equal(result.sessions[0]!.cacheReadTokens, 9_000);
    assert.equal(result.otherSessions, 1);
  });
});

test('a machine that does not answer costs a warning, not the rest of the answer', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.codex-homes', 'cx3');
    await login(home, ACCT_A);
    await rollout(home, { sessionId: 'local-1', records: [{ at: IN_WINDOW, usage: usage(100, 0, 10) }] });

    const result = await scanCodexBurn('codex-3', RESETS_AT, {
      base,
      accounts: [account('codex-3', home)],
      now: () => NOW,
      remotes: ['mac', 'hetzner'],
      scanRemote: async (host): Promise<RemoteBurnScan> => {
        if (host === 'mac') throw new Error('host is asleep');
        return { rows: [], shared: ['/root/.codex-fleet/sessions'], warnings: ['rollout-x: only the last 64 MiB were read'] };
      },
    });
    assert.deepEqual(result.sessions.map((session) => session.id), ['local-1']);
    assert.equal(result.sessions[0]!.host, null);
    assert.match(result.warnings.join(' '), /mac: host is asleep/);
    assert.match(result.warnings.join(' '), /hetzner:.*shared by several logins/);
    assert.match(result.warnings.join(' '), /hetzner: rollout-x/);
  });
});

test('says the machines were unreachable rather than claiming there is no store', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.subtrack', 'codex-homes', 'codex-3');
    await login(home, ACCT_A);
    const result = await scanCodexBurn('codex-3', RESETS_AT, {
      base,
      accounts: [account('codex-3', home)],
      now: () => NOW,
      remotes: ['mac'],
      scanRemote: async () => { throw new Error('no route to host'); },
    });
    assert.deepEqual(result.sessions, []);
    assert.match(result.warnings.join(' '), /no configured machine answered/);
  });
});
