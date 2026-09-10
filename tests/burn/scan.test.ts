import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGetBurn, scanBurn } from '../../src/burn/scan.ts';
import type { AccountConfig } from '../../src/types.ts';

const NOW = Date.parse('2026-09-05T11:00:00.000Z');
const RESETS_AT = '2026-09-05T13:00:00.000Z';   // window is 08:00 -> 13:00
const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';

async function withTempBase(fn: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-burn-'));
  try { await fn(base); } finally { await rm(base, { recursive: true, force: true }); }
}

function account(id: string, home: string, extra: Partial<AccountConfig> = {}): AccountConfig {
  return { id, label: `${id} · test`, provider: 'claude', enabled: true, credentialsHome: home, credentialsMode: 'readonly', ...extra } as AccountConfig;
}

/** Register a session id as owned by a home, the way Claude Code's per-home session-env does. */
async function own(home: string, id: string): Promise<void> {
  await mkdir(join(home, 'session-env', id), { recursive: true });
}

interface ReplyOptions { at: string; input?: number; cacheWrite?: number; cacheRead?: number; output?: number; model?: string }

function reply(id: string, cwd: string, o: ReplyOptions): object {
  return {
    type: 'assistant',
    sessionId: id,
    cwd,
    timestamp: o.at,
    message: {
      model: o.model ?? 'claude-opus-5',
      usage: {
        input_tokens: o.input ?? 0,
        cache_creation_input_tokens: o.cacheWrite ?? 0,
        cache_read_input_tokens: o.cacheRead ?? 0,
        output_tokens: o.output ?? 0,
      },
    },
  };
}

async function writeTranscript(base: string, projectKey: string, id: string, rows: object[], mtime = '2026-09-05T10:59:00.000Z'): Promise<void> {
  const dir = join(base, '.claude', 'projects', projectKey);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const when = new Date(mtime);
  await utimes(path, when, when);
}

test('attributes transcripts to the home that owns the session and ranks by weighted tokens', async () => {
  await withTempBase(async (base) => {
    const mine = join(base, '.claude-accounts', '4-acme');
    const theirs = join(base, '.claude-accounts', '2-hello');
    await own(mine, A);
    await own(mine, B);
    await own(theirs, C);
    const cwdA = join(base, 'projects', 'reactivation-agent');
    const cwdB = join(base, 'projects', 'amp-orbs');

    // A: output-heavy, B: cache-read-heavy. Weights are 1/1.25/0.1/5 (in/write/read/out).
    await writeTranscript(base, 'p-a', A, [
      reply(A, cwdA, { at: '2026-09-05T09:00:00.000Z', output: 1000, cacheRead: 1000 }),   // 5000 + 100
      reply(A, cwdA, { at: '2026-09-05T10:00:00.000Z', output: 1000, cacheWrite: 400 }),   // 5000 + 500
    ]);
    await writeTranscript(base, 'p-b', B, [
      reply(B, cwdB, { at: '2026-09-05T09:30:00.000Z', cacheRead: 10000, input: 100, model: 'claude-fable-5-1' }), // 1000 + 100
    ]);
    await writeTranscript(base, 'p-c', C, [reply(C, cwdB, { at: '2026-09-05T09:30:00.000Z', output: 99999 })]);

    const result = await scanBurn('claude-4', RESETS_AT, {
      base,
      accounts: [account('claude-4', mine), account('claude-2', theirs)],
      now: () => NOW,
    });

    assert.equal(result.windowStart, '2026-09-05T08:00:00.000Z');
    assert.deepEqual(result.sessions.map((s) => s.id), [A, B]);
    assert.equal(result.sessions[0]!.weight, 10600);
    assert.equal(result.sessions[1]!.weight, 1100);
    assert.equal(Math.round(result.sessions[0]!.share), 91);
    assert.equal(result.sessions[0]!.project, 'reactivation-agent');
    assert.equal(result.sessions[0]!.replies, 2);
    assert.deepEqual(result.sessions[1]!.models, ['claude-fable-5-1']);
    assert.equal(result.totals.outputTokens, 2000);
    // The other home's session is visible in the store but must never land in this account's share.
    assert.equal(result.otherSessions, 1);
    assert.equal(result.partial, false);
  });
});

test('counts only replies inside the window anchored on the provider reset', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.claude-accounts', '4-acme');
    await own(home, A);
    const cwd = join(base, 'projects', 'alpha');
    await writeTranscript(base, 'p-a', A, [
      reply(A, cwd, { at: '2026-09-05T07:59:00.000Z', output: 1000 }),   // before the window
      reply(A, cwd, { at: '2026-09-05T08:30:00.000Z', output: 10 }),     // inside
      reply(A, cwd, { at: '2026-09-05T11:30:00.000Z', output: 1000 }),   // after "now"
    ]);

    const result = await scanBurn('claude-4', RESETS_AT, { base, accounts: [account('claude-4', home)], now: () => NOW });

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.replies, 1);
    assert.equal(result.sessions[0]!.outputTokens, 10);
    assert.equal(result.sessions[0]!.lastAt, '2026-09-05T08:30:00.000Z');
  });
});

test('falls back to a rolling window when the provider reset is unknown', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.claude-accounts', '4-acme');
    await own(home, A);
    await writeTranscript(base, 'p-a', A, [reply(A, join(base, 'projects', 'alpha'), { at: '2026-09-05T07:30:00.000Z', output: 5 })]);

    const result = await scanBurn('claude-4', null, { base, accounts: [account('claude-4', home)], now: () => NOW });

    assert.equal(result.windowStart, '2026-09-05T06:00:00.000Z');
    assert.equal(result.resetsAt, null);
    assert.equal(result.sessions.length, 1);
  });
});

test('history.jsonl also proves ownership for sessions with no session-env directory', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.claude-accounts', '4-acme');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'history.jsonl'), `${JSON.stringify({ display: 'hi', sessionId: A })}\n`, 'utf8');
    await writeTranscript(base, 'p-a', A, [reply(A, join(base, 'projects', 'alpha'), { at: '2026-09-05T09:00:00.000Z', output: 7 })]);

    const result = await scanBurn('claude-4', RESETS_AT, { base, accounts: [account('claude-4', home)], now: () => NOW });

    assert.deepEqual(result.sessions.map((s) => s.id), [A]);
  });
});

test('a session claimed by two homes goes to the one that used it last, and is flagged when the rival is inside the window', async () => {
  await withTempBase(async (base) => {
    const mine = join(base, '.claude-accounts', '4-acme');
    const theirs = join(base, '.claude-accounts', '2-hello');
    const accounts = [account('claude-4', mine), account('claude-2', theirs)];
    const cwd = join(base, 'projects', 'shared');
    // A was resumed under both homes inside the window; B was ours long ago and theirs just now.
    await own(mine, A); await own(theirs, A);
    await own(mine, B); await own(theirs, B);
    await mkdir(mine, { recursive: true }); await mkdir(theirs, { recursive: true });
    await writeFile(join(mine, 'history.jsonl'), [
      JSON.stringify({ sessionId: A, timestamp: Date.parse('2026-09-05T10:00:00.000Z') }),
      JSON.stringify({ sessionId: B, timestamp: Date.parse('2026-09-01T10:00:00.000Z') }),
    ].join('\n'), 'utf8');
    await writeFile(join(theirs, 'history.jsonl'), [
      JSON.stringify({ sessionId: A, timestamp: Date.parse('2026-09-05T09:00:00.000Z') }),
      JSON.stringify({ sessionId: B, timestamp: Date.parse('2026-09-05T10:30:00.000Z') }),
    ].join('\n'), 'utf8');
    await writeTranscript(base, 'p-a', A, [reply(A, cwd, { at: '2026-09-05T10:00:00.000Z', output: 100 })]);
    await writeTranscript(base, 'p-b', B, [reply(B, cwd, { at: '2026-09-05T10:30:00.000Z', output: 100 })]);

    const ours = await scanBurn('claude-4', RESETS_AT, { base, accounts, now: () => NOW });
    assert.deepEqual(ours.sessions.map((s) => s.id), [A], 'B was last used by the other account');
    assert.equal(ours.sessions[0]!.contested, true, 'the rival also ran A inside this window');
    assert.equal(ours.otherSessions, 1);

    const others = await scanBurn('claude-2', RESETS_AT, { base, accounts, now: () => NOW });
    assert.deepEqual(others.sessions.map((s) => s.id), [B]);
    // Our claim on B is days old, so from their side the row is theirs alone — not contested.
    assert.equal(others.sessions[0]!.contested, false);
  });
});

test('an undisputed session is never flagged as contested', async () => {
  await withTempBase(async (base) => {
    const mine = join(base, '.claude-accounts', '4-acme');
    await own(mine, A);
    await writeTranscript(base, 'p-a', A, [reply(A, join(base, 'projects', 'alpha'), { at: '2026-09-05T09:00:00.000Z', output: 5 })]);

    const result = await scanBurn('claude-4', RESETS_AT, { base, accounts: [account('claude-4', mine)], now: () => NOW });

    assert.equal(result.sessions[0]!.contested, false);
  });
});

test('refuses attribution for non-Claude and subtrack-owned homes instead of guessing', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.subtrack', 'claude-homes', 'claude-9');
    await own(home, A);
    const owned = await scanBurn('claude-9', RESETS_AT, {
      base,
      accounts: [account('claude-9', home, { credentialsMode: 'owned' })],
      now: () => NOW,
    });
    assert.deepEqual(owned.sessions, []);
    assert.equal(owned.partial, true);
    assert.match(owned.warnings.join(' '), /read-only/);

    // Codex has its own scanner; this one must not try to read a Codex home as a Claude one.
    const grok = await scanBurn('grok-1', RESETS_AT, {
      base,
      accounts: [account('grok-1', home, { provider: 'grok' })],
      now: () => NOW,
    });
    assert.deepEqual(grok.sessions, []);
    assert.match(grok.warnings.join(' '), /Claude and Codex/);

    const missing = await scanBurn('claude-nope', RESETS_AT, { base, accounts: [], now: () => NOW });
    assert.match(missing.warnings.join(' '), /Unknown account/);
  });
});

test('caches per account and window, and rescans once the provider rolls the window', async () => {
  await withTempBase(async (base) => {
    const home = join(base, '.claude-accounts', '4-acme');
    await own(home, A);
    await writeTranscript(base, 'p-a', A, [reply(A, join(base, 'projects', 'alpha'), { at: '2026-09-05T09:00:00.000Z', output: 1 })]);
    let now = NOW;
    const getBurn = makeGetBurn({ base, accounts: [account('claude-4', home)], now: () => now, cacheMs: 30_000 });

    const first = await getBurn('claude-4', RESETS_AT);
    const second = await getBurn('claude-4', RESETS_AT);
    assert.equal(second, first, 'same window within the cache window must reuse the answer');

    now += 31_000;
    const third = await getBurn('claude-4', RESETS_AT);
    assert.notEqual(third, first);

    const rolled = await getBurn('claude-4', '2026-09-05T18:00:00.000Z');
    assert.equal(rolled.windowStart, '2026-09-05T13:00:00.000Z');
  });
});
