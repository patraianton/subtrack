import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Poller } from '../src/poller.ts';
import { SnapshotStore } from '../src/snapshotStore.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { AccountConfig, NormalizedUsage, SubtrackConfig } from '../src/types.ts';

const accounts: AccountConfig[] = [
  { id: 'c1', label: 'C1', provider: 'claude', enabled: true },
  { id: 'x1', label: 'X1', provider: 'codex', enabled: true },
  { id: 'off', label: 'Off', provider: 'claude', enabled: false },
];
const config: SubtrackConfig = { ...DEFAULT_CONFIG, accounts };

function ok(id: string): NormalizedUsage {
  return { accountId: id, label: id, provider: 'claude', session: { utilization: 10, resetsAt: '2026-06-29T17:00:00.000Z' }, weekly: null, weeklyOpus: null, fable: { utilization: 88, resetsAt: '2026-06-29T17:00:00.000Z' }, fableAccess: true, status: 'ok', lastUpdated: '', error: null, retryAt: null };
}
function throttled(id: string): NormalizedUsage {
  return { ...ok(id), status: 'throttled' };
}

test('first tick fetches all enabled accounts, skips disabled', async () => {
  const store = new SnapshotStore();
  const fetched: string[] = [];
  const p = new Poller({ config, store, clock: () => 0, fetchUsage: async (a) => { fetched.push(a.id); return ok(a.id); } });
  await p.tick(0);          // c1 is due at construction (stagger index 0)
  await p.tick(7000);       // x1 becomes due after one STAGGER_MS (index 1)
  assert.deepEqual(fetched.sort(), ['c1', 'x1']);
  assert.equal(store.get('off'), undefined);
});

test('account is not re-fetched until its provider TTL elapses', async () => {
  const store = new SnapshotStore();
  let calls = 0;
  let clock = 0;
  const p = new Poller({ config: { ...config, accounts: [accounts[0]!] }, store, clock: () => clock, fetchUsage: async (a) => { calls++; return ok(a.id); } });
  await p.tick(0);            // claude fetched (TTL 180s)
  clock = 100_000;           // 100s later
  await p.tick(clock);       // still within 180s -> no fetch
  assert.equal(calls, 1);
  clock = 181_000;           // past 180s
  await p.tick(clock);
  assert.equal(calls, 2);
});

test('throttled result freezes the account with escalating backoff', async () => {
  const store = new SnapshotStore();
  let clock = 0;
  const p = new Poller({ config: { ...config, accounts: [accounts[0]!] }, store, clock: () => clock, fetchUsage: async (a) => throttled(a.id) });
  await p.tick(0);                 // throttled -> backoff 5min
  clock = 4 * 60_000;              // within the 5min freeze
  assert.deepEqual(p.due(clock).map((a) => a.id), []);
  clock = 5 * 60_000 + 1;
  assert.deepEqual(p.due(clock).map((a) => a.id), ['c1']);
  assert.equal(store.get('c1')?.retryAt, new Date(5 * 60_000).toISOString());
});

test('non-ok result carries forward last-known windows (never blanks)', async () => {
  const store = new SnapshotStore();
  let clock = 0;
  let blank = false;
  const p = new Poller({
    config: { ...config, accounts: [accounts[0]!] }, store, clock: () => clock,
    fetchUsage: async (a) => blank
      ? { accountId: a.id, label: a.id, provider: 'claude', session: null, weekly: null, weeklyOpus: null, fable: null, fableAccess: false, status: 'throttled', lastUpdated: '', error: '429', retryAt: null }
      : ok(a.id),
  });
  await p.tick(0);                              // ok: session util 10 stored
  assert.equal(store.get('c1')?.session?.utilization, 10);
  blank = true;
  clock = 181_000;                              // past TTL
  await p.tick(clock);                          // throttled with null windows
  const u = store.get('c1')!;
  assert.equal(u.status, 'throttled');
  assert.equal(u.session?.utilization, 10);     // carried forward, NOT blanked
  assert.equal(u.fable?.utilization, 88);       // fable bucket also carried forward
  assert.equal(u.fableAccess, true);            // access fact stays visible through the error
});

test('auth_error pauses the account well past its normal TTL', async () => {
  const store = new SnapshotStore();
  let clock = 0;
  const p = new Poller({
    config: { ...config, accounts: [accounts[0]!] }, store, clock: () => clock,
    fetchUsage: async (a) => ({ ...ok(a.id), status: 'auth_error', session: null, weekly: null }),
  });
  await p.tick(0);
  clock = 181_000;                              // past 180s TTL but inside 15min pause
  assert.deepEqual(p.due(clock).map((a) => a.id), []);
  clock = 16 * 60_000;
  assert.deepEqual(p.due(clock).map((a) => a.id), ['c1']);
});

test('one failing account does not block others', async () => {
  const store = new SnapshotStore();
  const p = new Poller({ config, store, clock: () => 0, fetchUsage: async (a) => (a.id === 'c1' ? Promise.reject(new Error('boom')) : ok(a.id)) });
  await p.tick(0);            // c1 (index 0) fetched -> rejects -> error
  await p.tick(7000);         // x1 (index 1) due after stagger
  assert.equal(store.get('c1')?.status, 'error');
  assert.equal(store.get('x1')?.status, 'ok');
});

test('tick() does not run concurrently with itself (in-flight guard)', async () => {
  const store = new SnapshotStore();
  let resolveGate!: () => void;
  const gate = new Promise<void>((r) => { resolveGate = r; });
  let calls = 0;
  const p = new Poller({
    config: { ...config, accounts: [accounts[0]!] }, store, clock: () => 0,
    fetchUsage: async (a) => { calls += 1; await gate; return ok(a.id); },
  });
  const first = p.tick(0);     // enters, sets running=true, blocks inside fetchUsage
  await p.tick(0);             // running === true -> returns immediately, no fetch
  assert.equal(calls, 1);      // the second tick did not fetch
  resolveGate();
  await first;
  assert.equal(calls, 1);      // still only one fetch after first tick resolves
});

// The provider's own Retry-After wins over the 5/10/15 ladder when it asks for longer: hitting a
// rate-limited endpoint early only re-hits a closed door and can extend the block.
test('throttled honours a provider Retry-After longer than the ladder step', async () => {
  const store = new SnapshotStore();
  let clock = 0;
  const p = new Poller({
    config: { ...config, accounts: [accounts[0]!] }, store, clock: () => clock,
    fetchUsage: async (a) => ({ ...throttled(a.id), retryAt: new Date(33 * 60_000).toISOString() }),
  });
  await p.tick(0);
  assert.equal(store.get('c1')?.retryAt, new Date(33 * 60_000).toISOString());
  clock = 32 * 60_000;
  assert.deepEqual(p.due(clock).map((a) => a.id), []);
  clock = 33 * 60_000 + 1;
  assert.deepEqual(p.due(clock).map((a) => a.id), ['c1']);
});

test('throttled keeps the ladder step when Retry-After is shorter, and caps a wild one at an hour', async () => {
  const store = new SnapshotStore();
  let asked = 60_000;                                  // one minute — shorter than the 5min step
  const p1 = new Poller({
    config: { ...config, accounts: [accounts[0]!] }, store, clock: () => 0,
    fetchUsage: async (a) => ({ ...throttled(a.id), retryAt: new Date(asked).toISOString() }),
  });
  await p1.tick(0);
  assert.equal(store.get('c1')?.retryAt, new Date(5 * 60_000).toISOString());

  asked = 9 * 60 * 60_000;                             // nine hours — a card must not go dark that long
  const store2 = new SnapshotStore();
  const p2 = new Poller({
    config: { ...config, accounts: [accounts[0]!] }, store: store2, clock: () => 0,
    fetchUsage: async (a) => ({ ...throttled(a.id), retryAt: new Date(asked).toISOString() }),
  });
  await p2.tick(0);
  assert.equal(store2.get('c1')?.retryAt, new Date(60 * 60_000).toISOString());
});
