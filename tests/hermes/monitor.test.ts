import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HermesFleetMonitor, sanitizeHermesDiagnostic } from '../../src/hermes/monitor.ts';
import type { HermesMonitorConfig } from '../../src/hermes/types.ts';

const ACCOUNT = 'account-a-id';
const ACCESS = `x.${Buffer.from(JSON.stringify({ exp: 4_102_444_800, 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT } })).toString('base64url')}.y`;

function config(root: string): HermesMonitorConfig {
  return {
    version: 1, enabled: true, profileRoot: root, hermesCommand: 'hermes.exe',
    checkIntervalSeconds: 120, authProbeSeconds: 300, canarySeconds: 21_600, canaryRetrySeconds: 1800,
    restartAfterFailures: 2, restartCooldownSeconds: 1800, maxRestartsPerHour: 3, autoRestart: true,
    subscriptions: [{ id: 'a', label: 'Subscription A', authFile: join(root, 'shared-a.json'), expectedAccountId: ACCOUNT, probeProfile: 'alexey' }],
    profileOverrides: {},
  };
}

function missing(path: string): never {
  const error = new Error(`missing ${path}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  throw error;
}

test('Hermes diagnostics redact opaque credentials before logs or webhooks', () => {
  const safe = sanitizeHermesDiagnostic('refresh_token=rt_supersecret123 OPENAI_API_KEY=sk-secretvalue123456 ?access_token=opaque-value');
  assert.doesNotMatch(safe, /supersecret|secretvalue|opaque-value/);
  assert.match(safe, /\[redacted/);
});

test('background monitor waits for two confirmed runtime failures before one safe restart', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-hermes-monitor-'));
  const root = join(base, 'profiles');
  let now = Date.parse('2026-07-17T12:00:00Z');
  let restarts = 0;
  const auth = JSON.stringify({ providers: { 'openai-codex': { account_id: ACCOUNT, tokens: { access_token: ACCESS, refresh_token: 'refresh-secret' } } } });
  const monitor = await HermesFleetMonitor.create({
    base, config: config(root), now: () => now,
    listDirectories: async () => ['alexey'], isDirectory: async () => true, modifiedAt: async () => null,
    readText: async (path) => {
      if (path.endsWith('.env')) return `HERMES_CODEX_AUTH_FILE=${join(root, 'shared-a.json')}\nTELEGRAM_BOT_TOKEN=x`;
      if (path.endsWith('shared-a.json')) return auth;
      return missing(path);
    },
    runPwsh: async () => ({ code: 0, stdout: '{"processes":[]}', stderr: '' }),
    fetchImpl: async () => new Response('{}', { status: 200 }),
    runCanary: async () => ({ status: 'up', detail: 'real model canary passed', checkedAt: new Date(now).toISOString() }),
    restartProfile: async () => { restarts += 1; return { status: 'up', detail: 'safe Hermes restart completed', checkedAt: new Date(now).toISOString() }; },
  });
  assert.ok(monitor);
  try {
    await monitor.runOnce();
    assert.equal(restarts, 0);
    assert.equal(monitor.getSnapshot().profiles[0]!.consecutiveRuntimeFailures, 1);
    now += 120_000;
    await monitor.runOnce();
    assert.equal(restarts, 1);
    assert.match(monitor.getSnapshot().profiles[0]!.detail, /auto-restart completed/);
    assert.equal(monitor.serviceRows().some((row) => row.id === 'hermes-alexey' && row.kind === 'hermes'), true);
  } finally { monitor.stop(); await rm(base, { recursive: true, force: true }); }
});

test('account mismatch is critical but never causes a gateway restart', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-hermes-auth-'));
  const root = join(base, 'profiles');
  const startMs = Date.parse('2026-07-17T11:00:00Z');
  let now = Date.parse('2026-07-17T12:00:00Z');
  let restarts = 0;
  let canaries = 0;
  const files = new Map<string, string>([
    [join(root, 'alexey', '.env'), `HERMES_CODEX_AUTH_FILE=${join(root, 'shared-a.json')}`],
    [join(root, 'shared-a.json'), JSON.stringify({ providers: { 'openai-codex': { account_id: 'wrong', tokens: { access_token: ACCESS, refresh_token: 'x' } } } })],
    [join(root, 'alexey', 'gateway.pid'), JSON.stringify({ pid: 9, kind: 'hermes-gateway', argv: ['main.py', 'gateway', 'run'], start_time: startMs / 10 })],
    [join(root, 'alexey', 'gateway_state.json'), JSON.stringify({ pid: 9, kind: 'hermes-gateway', start_time: startMs / 10, gateway_state: 'running', platforms: {} })],
  ]);
  const monitor = await HermesFleetMonitor.create({
    base, config: config(root), now: () => now,
    listDirectories: async () => ['alexey'], isDirectory: async () => true, modifiedAt: async () => null,
    readText: async (path) => files.get(path) ?? missing(path),
    runPwsh: async () => ({ code: 0, stdout: '{"processes":[]}', stderr: '' }),
    fetchImpl: async () => new Response('{}', { status: 401 }),
    runCanary: async () => { canaries += 1; return { status: 'down', detail: 'real model canary hit an auth failure', checkedAt: new Date(now).toISOString() }; },
    restartProfile: async () => { restarts += 1; return { status: 'up', detail: 'unexpected', checkedAt: new Date(now).toISOString() }; },
  });
  assert.ok(monitor);
  try {
    await monitor.runOnce(); now += 120_000; await monitor.runOnce();
    assert.equal(restarts, 0, 'an outage plus unsafe auth must not start Hermes on the wrong account');
    assert.equal(canaries, 0, 'account mismatch must never invoke a credential-mutating Hermes owner action');
    assert.equal(monitor.getSnapshot().subscriptions[0]!.status, 'down');
    assert.match(monitor.getSnapshot().subscriptions[0]!.detail, /account pin mismatch|auth failure/);
  } finally { monitor.stop(); await rm(base, { recursive: true, force: true }); }
});

test('an override cannot authorize a canary when the profile env is bound to another auth file', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-hermes-binding-'));
  const root = join(base, 'profiles');
  let canaries = 0;
  let restarts = 0;
  const unsafeConfig = config(root);
  unsafeConfig.profileOverrides = { alexey: { subscriptionId: 'a' } };
  const monitor = await HermesFleetMonitor.create({
    base, config: unsafeConfig,
    listDirectories: async () => ['alexey'], isDirectory: async () => true, modifiedAt: async () => null,
    readText: async (path) => {
      if (path.endsWith('.env')) return `HERMES_CODEX_AUTH_FILE=${join(root, 'some-other-auth.json')}`;
      if (path.endsWith('shared-a.json')) return JSON.stringify({ providers: { 'openai-codex': {
        account_id: ACCOUNT, tokens: { access_token: ACCESS, refresh_token: 'refresh' },
      } } });
      return missing(path);
    },
    runPwsh: async () => ({ code: 0, stdout: '{"processes":[]}', stderr: '' }),
    fetchImpl: async () => new Response('{}', { status: 200 }),
    runCanary: async () => { canaries += 1; return { status: 'up', detail: 'unexpected', checkedAt: new Date().toISOString() }; },
    restartProfile: async () => { restarts += 1; return { status: 'up', detail: 'unexpected', checkedAt: new Date().toISOString() }; },
  });
  assert.ok(monitor);
  try {
    await monitor.runOnce();
    await monitor.runOnce();
    assert.equal(canaries, 0);
    assert.equal(restarts, 0);
    assert.notEqual(monitor.getSnapshot().profiles[0]!.status, 'up');
    assert.match(monitor.getSnapshot().profiles[0]!.detail, /wrong canonical auth store/);
  } finally { monitor.stop(); await rm(base, { recursive: true, force: true }); }
});

test('a live 401 triggers one Hermes-owned refresh after cooldown and does not churn every five minutes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-hermes-refresh-'));
  const root = join(base, 'profiles');
  const startMs = Date.parse('2026-07-17T11:00:00Z');
  let now = Date.parse('2026-07-17T12:00:00Z');
  let canaries = 0;
  let fetches = 0;
  const files = new Map<string, string>([
    [join(root, 'alexey', '.env'), `HERMES_CODEX_AUTH_FILE=${join(root, 'shared-a.json')}`],
    [join(root, 'shared-a.json'), JSON.stringify({ providers: { 'openai-codex': { account_id: ACCOUNT, tokens: { access_token: ACCESS, refresh_token: 'x' } } } })],
    [join(root, 'alexey', 'gateway.pid'), JSON.stringify({ pid: 9, kind: 'hermes-gateway', argv: ['main.py', 'gateway', 'run'], start_time: startMs / 10 })],
    [join(root, 'alexey', 'gateway_state.json'), JSON.stringify({ pid: 9, kind: 'hermes-gateway', start_time: startMs / 10, gateway_state: 'running', platforms: {} })],
  ]);
  const monitor = await HermesFleetMonitor.create({
    base, config: config(root), now: () => now,
    listDirectories: async () => ['alexey'], isDirectory: async () => true, modifiedAt: async () => null,
    readText: async (path) => files.get(path) ?? missing(path),
    runPwsh: async () => ({ code: 0, stdout: JSON.stringify({ processes: [{ pid: 9, name: 'pythonw.exe', cmd: 'pythonw -m hermes_cli.main --profile alexey gateway run', startedAt: new Date(startMs).toISOString() }] }), stderr: '' }),
    fetchImpl: async () => { fetches += 1; return new Response('{}', { status: fetches === 2 ? 401 : 200 }); },
    runCanary: async () => { canaries += 1; return { status: 'up', detail: 'real model canary passed', checkedAt: new Date(now).toISOString() }; },
  });
  assert.ok(monitor);
  try {
    await monitor.runOnce();
    assert.equal(canaries, 1);
    now += 1_800_000;
    await monitor.runOnce();
    assert.equal(canaries, 2, '401 forced an early Hermes-owned canary');
    assert.equal(fetches, 3, 'the monitor re-probed immediately after the canary');
    assert.equal(monitor.getSnapshot().subscriptions[0]!.status, 'up');
    now += 300_000;
    await monitor.runOnce();
    assert.equal(canaries, 2, 'a persistent 401 cannot cause five-minute canary churn');
  } finally { monitor.stop(); await rm(base, { recursive: true, force: true }); }
});

test('a hung process inventory is bounded, reported unknown, and a later cycle can recover', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-hermes-timeout-'));
  const root = join(base, 'profiles');
  const startMs = Date.parse('2026-07-17T11:00:00Z');
  let calls = 0;
  const command = 'pythonw -m hermes_cli.main --profile alexey gateway run';
  const monitor = await HermesFleetMonitor.create({
    base, config: config(root), processSnapshotTimeoutMs: 10,
    listDirectories: async () => ['alexey'], isDirectory: async () => true, modifiedAt: async () => null,
    readText: async (path) => {
      if (path.endsWith('.env')) return `HERMES_CODEX_AUTH_FILE=${join(root, 'shared-a.json')}`;
      if (path.endsWith('shared-a.json')) return JSON.stringify({ providers: { 'openai-codex': {
        account_id: ACCOUNT, tokens: { access_token: ACCESS, refresh_token: 'refresh' },
      } } });
      if (path.endsWith('gateway.pid')) return JSON.stringify({ pid: 9, kind: 'hermes-gateway', argv: ['gateway', 'run'], start_time: startMs / 10 });
      if (path.endsWith('gateway_state.json')) return JSON.stringify({ pid: 9, kind: 'hermes-gateway', start_time: startMs / 10, gateway_state: 'running', platforms: {} });
      return missing(path);
    },
    runPwsh: async () => {
      calls += 1;
      if (calls === 1) return await new Promise(() => {});
      return { code: 0, stdout: JSON.stringify({ processes: [{ pid: 9, name: 'pythonw.exe', cmd: command, startedAt: new Date(startMs).toISOString() }] }), stderr: '' };
    },
    fetchImpl: async () => new Response('{}', { status: 200 }),
    runCanary: async () => ({ status: 'up', detail: 'real model canary passed', checkedAt: new Date().toISOString() }),
  });
  assert.ok(monitor);
  try {
    await monitor.runOnce();
    assert.equal(monitor.getSnapshot().profiles[0]!.status, 'unknown');
    await monitor.runOnce();
    assert.equal(monitor.getSnapshot().profiles[0]!.status, 'up');
  } finally { monitor.stop(); await rm(base, { recursive: true, force: true }); }
});

test('a restart attempt is persisted before Hermes runs, preserving cooldown across a crash', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-hermes-reservation-'));
  const root = join(base, 'profiles');
  let now = Date.parse('2026-07-17T12:00:00Z');
  let restarts = 0;
  const deps = () => ({
    base, config: config(root), now: () => now,
    listDirectories: async () => ['alexey'], isDirectory: async () => true, modifiedAt: async () => null,
    readText: async (path: string) => {
      if (path.endsWith('.env')) return `HERMES_CODEX_AUTH_FILE=${join(root, 'shared-a.json')}`;
      if (path.endsWith('shared-a.json')) return JSON.stringify({ providers: { 'openai-codex': {
        account_id: ACCOUNT, tokens: { access_token: ACCESS, refresh_token: 'refresh' },
      } } });
      return missing(path);
    },
    runPwsh: async () => ({ code: 0, stdout: '{"processes":[]}', stderr: '' }),
    fetchImpl: async () => new Response('{}', { status: 200 }),
    runCanary: async () => ({ status: 'up' as const, detail: 'real model canary passed', checkedAt: new Date(now).toISOString() }),
    restartProfile: async () => { restarts += 1; throw new Error('simulated process crash during restart'); },
  });
  const first = await HermesFleetMonitor.create(deps());
  assert.ok(first);
  try {
    await first.runOnce();
    now += 120_000;
    await first.runOnce();
    assert.equal(restarts, 1);
  } finally { first.stop(); }

  now += 1_000;
  const afterCrash = await HermesFleetMonitor.create(deps());
  assert.ok(afterCrash);
  try {
    await afterCrash.runOnce();
    assert.equal(restarts, 1, 'persisted cooldown prevents a duplicate recovery action');
  } finally { afterCrash.stop(); await rm(base, { recursive: true, force: true }); }
});

test('valid JSON with a wrong state shape blocks all automatic owner actions for the process lifetime', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-hermes-corrupt-'));
  const root = join(base, 'profiles');
  await mkdir(join(base, '.subtrack'), { recursive: true });
  await writeFile(join(base, '.subtrack', 'hermes-monitor-state.json'), JSON.stringify({
    version: 1, profiles: [], subscriptions: {}, recentEvents: [],
  }), 'utf8');
  let canaries = 0;
  let restarts = 0;
  const monitor = await HermesFleetMonitor.create({
    base, config: config(root),
    listDirectories: async () => ['alexey'], isDirectory: async () => true, modifiedAt: async () => null,
    readText: async (path) => {
      if (path.endsWith('.env')) return `HERMES_CODEX_AUTH_FILE=${join(root, 'shared-a.json')}`;
      if (path.endsWith('shared-a.json')) return JSON.stringify({ providers: { 'openai-codex': {
        account_id: ACCOUNT, tokens: { access_token: ACCESS, refresh_token: 'refresh' },
      } } });
      return missing(path);
    },
    runPwsh: async () => ({ code: 0, stdout: '{"processes":[]}', stderr: '' }),
    fetchImpl: async () => new Response('{}', { status: 200 }),
    runCanary: async () => { canaries += 1; return { status: 'up', detail: 'unexpected', checkedAt: new Date().toISOString() }; },
    restartProfile: async () => { restarts += 1; return { status: 'up', detail: 'unexpected', checkedAt: new Date().toISOString() }; },
  });
  assert.ok(monitor);
  try {
    await monitor.runOnce();
    await monitor.runOnce();
    assert.equal(canaries, 0);
    assert.equal(restarts, 0);
    assert.equal(monitor.serviceRows()[0]!.autoHeal, false);
    assert.match(monitor.getSnapshot().detail, /automatic recovery blocked/);
  } finally { monitor.stop(); await rm(base, { recursive: true, force: true }); }
});
