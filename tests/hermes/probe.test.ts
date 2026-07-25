import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HermesMonitorConfig, HermesProcessSnapshot, HermesSubscriptionHealth } from '../../src/hermes/types.ts';
import {
  commandMatchesProfile,
  discoverHermesProfiles,
  inspectHermesAuth,
  probeHermesProfile,
  publicSubscriptionHealth,
} from '../../src/hermes/probe.ts';
import { parseHermesProcesses } from '../../src/hermes/windows.ts';

function jwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

const NOW = Date.parse('2026-07-17T12:00:00.000Z');
const ACCOUNT_A = 'account-a-id';
const ACCESS = jwt({ exp: Math.floor((NOW + 86_400_000) / 1000), 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_A } });

const CONFIG: HermesMonitorConfig = {
  version: 1, enabled: true, profileRoot: 'C:\\profiles', hermesCommand: 'C:\\hermes.exe',
  checkIntervalSeconds: 120, authProbeSeconds: 300, canarySeconds: 21_600, canaryRetrySeconds: 1800,
  restartAfterFailures: 2, restartCooldownSeconds: 1800, maxRestartsPerHour: 3, autoRestart: true,
  subscriptions: [{ id: 'a', label: 'Subscription A', authFile: 'C:\\shared\\a\\auth.json', expectedAccountId: ACCOUNT_A }],
  profileOverrides: {},
};

test('discovers installed gateway profiles from shared-auth binding and infers Telegram', async () => {
  const env = new Map([
    ['C:\\profiles\\alexey\\.env', 'HERMES_CODEX_AUTH_FILE=C:\\shared\\a\\auth.json\nTELEGRAM_BOT_TOKEN=secret'],
    ['C:\\profiles\\taras\\.env', 'HERMES_CODEX_AUTH_FILE=C:\\shared\\a\\auth.json'],
  ]);
  const profiles = await discoverHermesProfiles(CONFIG, {
    listDirectories: async () => ['taras', 'general', 'alexey'],
    isDirectory: async (path) => !path.includes('general'),
    readText: async (path) => env.get(path)!,
  });
  assert.deepEqual(profiles.map((profile) => [profile.id, profile.expectedPlatform, profile.subscription?.id]), [
    ['alexey', 'telegram', 'a'], ['taras', 'none', 'a'],
  ]);
});

test('configured expected profiles remain visible when their directory disappears', async () => {
  const expected = structuredClone(CONFIG);
  expected.profileOverrides = { ostap: { subscriptionId: 'a', expectedPlatform: 'telegram' } };
  const profiles = await discoverHermesProfiles(expected, {
    listDirectories: async () => [],
    isDirectory: async () => false,
    readText: async () => { const error = new Error('missing') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; },
  });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]!.id, 'ostap');
  assert.equal(profiles[0]!.subscription?.id, 'a');
  assert.match(profiles[0]!.discoveryError ?? '', /gateway-service is missing/);
  const health = await probeHermesProfile(profiles[0]!, null, { ok: true, processes: [] }, NOW, {
    readText: async () => { const error = new Error('missing') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; },
    modifiedAt: async () => null,
  });
  assert.equal(health.runtimeFailureConfirmed, false, 'missing expected inventory stays visible but cannot authorize restart');
});

test('validates canonical account pin, refresh token and JWT account claim without exposing tokens', async () => {
  const raw = JSON.stringify({ providers: { 'openai-codex': { account_id: ACCOUNT_A, last_refresh: '2026-07-17T10:00:00Z', tokens: { access_token: ACCESS, refresh_token: 'refresh-secret' } } } });
  const inspected = await inspectHermesAuth(CONFIG.subscriptions[0]!, NOW, async () => raw);
  assert.equal(inspected.status, 'up');
  assert.equal(inspected.ownerMutationSafe, true);
  assert.equal(inspected.accountId, ACCOUNT_A);
  assert.equal(inspected.accessExpiresAt, '2026-07-18T12:00:00.000Z');
  assert.doesNotMatch(inspected.detail, /refresh-secret|eyJ/);

  const mismatch = await inspectHermesAuth(CONFIG.subscriptions[0]!, NOW, async () => JSON.stringify({
    providers: { 'openai-codex': { account_id: 'wrong-account', tokens: { access_token: ACCESS, refresh_token: 'x' } } },
  }));
  assert.equal(mismatch.status, 'down');
  assert.equal(mismatch.ownerMutationSafe, false);
  assert.match(mismatch.detail, /account pin mismatch/);
});

test('Hermes owner actions allow an expired matching credential but fail closed on ambiguous ownership', async () => {
  const expired = jwt({ exp: Math.floor((NOW - 60_000) / 1000), 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_A } });
  const matchingExpired = await inspectHermesAuth(CONFIG.subscriptions[0]!, NOW, async () => JSON.stringify({
    providers: { 'openai-codex': { account_id: ACCOUNT_A, tokens: { access_token: expired, refresh_token: 'refresh' } } },
  }));
  assert.equal(matchingExpired.status, 'degraded');
  assert.equal(matchingExpired.ownerMutationSafe, true, 'expiry is refreshable by the proven Hermes owner');

  const wrongClaim = await inspectHermesAuth(CONFIG.subscriptions[0]!, NOW, async () => JSON.stringify({
    providers: { 'openai-codex': { account_id: ACCOUNT_A, tokens: { access_token: jwt({ chatgpt_account_id: 'wrong' }), refresh_token: 'refresh' } } },
  }));
  assert.equal(wrongClaim.ownerMutationSafe, false);

  const missingClaim = await inspectHermesAuth(CONFIG.subscriptions[0]!, NOW, async () => JSON.stringify({
    providers: { 'openai-codex': { account_id: ACCOUNT_A, tokens: { access_token: jwt({ exp: 4_102_444_800 }), refresh_token: 'refresh' } } },
  }));
  assert.equal(missingClaim.ownerMutationSafe, false);

  const relogin = await inspectHermesAuth(CONFIG.subscriptions[0]!, NOW, async () => JSON.stringify({
    providers: { 'openai-codex': { account_id: ACCOUNT_A, last_auth_error: { relogin_required: true }, tokens: { access_token: ACCESS, refresh_token: 'refresh' } } },
  }));
  assert.equal(relogin.ownerMutationSafe, false);
});

test('proves profile health from PID identity, start time, state and required platform', async () => {
  const auth: HermesSubscriptionHealth = {
    id: 'a', label: 'Subscription A', status: 'up', detail: 'ok', checkedAt: new Date(NOW).toISOString(),
    accessExpiresAt: null, lastRefreshAt: null, usageProbe: null, canary: null,
  };
  const startMs = NOW - 10_000;
  const processSnapshot: HermesProcessSnapshot = { ok: true, processes: [{
    pid: 42, name: 'pythonw.exe', startedAt: new Date(startMs).toISOString(),
    cmd: 'pythonw.exe -m hermes_cli.main --profile alexey gateway run',
  }] };
  const files = new Map([
    ['C:\\profiles\\alexey\\gateway.pid', JSON.stringify({ pid: 42, kind: 'hermes-gateway', argv: ['main.py', 'gateway', 'run'], start_time: startMs / 10 })],
    ['C:\\profiles\\alexey\\gateway_state.json', JSON.stringify({ pid: 42, kind: 'hermes-gateway', start_time: startMs / 10, gateway_state: 'running', platforms: { telegram: { state: 'connected' } } })],
  ]);
  const result = await probeHermesProfile({
    id: 'alexey', label: 'alexey', home: 'C:\\profiles\\alexey', authFile: CONFIG.subscriptions[0]!.authFile,
    subscription: CONFIG.subscriptions[0]!, expectedPlatform: 'telegram', discoveryError: null,
  }, auth, processSnapshot, NOW, { readText: async (path) => files.get(path)!, modifiedAt: async () => null });
  assert.equal(result.status, 'up');
  assert.equal(result.pid, 42);
  assert.equal(result.runtimeFailureConfirmed, false);

  files.set('C:\\profiles\\alexey\\gateway_state.json', JSON.stringify({ pid: 42, kind: 'hermes-gateway', start_time: startMs / 10, gateway_state: 'running', platforms: { telegram: { state: 'retrying' } } }));
  const disconnected = await probeHermesProfile({
    id: 'alexey', label: 'alexey', home: 'C:\\profiles\\alexey', authFile: CONFIG.subscriptions[0]!.authFile,
    subscription: CONFIG.subscriptions[0]!, expectedPlatform: 'telegram', discoveryError: null,
  }, auth, processSnapshot, NOW, { readText: async (path) => files.get(path)!, modifiedAt: async () => null });
  assert.equal(disconnected.status, 'degraded');
  assert.match(disconnected.detail, /Telegram/);
});

test('Taras is healthy without Telegram, while a confirmed missing process is restart-eligible', async () => {
  const auth = publicSubscriptionHealth(await inspectHermesAuth(CONFIG.subscriptions[0]!, NOW, async () => JSON.stringify({
    providers: { 'openai-codex': { account_id: ACCOUNT_A, tokens: { access_token: ACCESS, refresh_token: 'x' } } },
  })));
  const startMs = NOW - 20_000;
  const files = new Map([
    ['C:\\profiles\\taras\\gateway.pid', JSON.stringify({ pid: 7, kind: 'hermes-gateway', argv: ['main.py', 'gateway', 'run'], start_time: startMs / 10 })],
    ['C:\\profiles\\taras\\gateway_state.json', JSON.stringify({ pid: 7, kind: 'hermes-gateway', start_time: startMs / 10, gateway_state: 'running', platforms: {} })],
  ]);
  const profile = { id: 'taras', label: 'taras', home: 'C:\\profiles\\taras', authFile: CONFIG.subscriptions[0]!.authFile, subscription: CONFIG.subscriptions[0]!, expectedPlatform: 'none' as const, discoveryError: null };
  const up = await probeHermesProfile(profile, auth, { ok: true, processes: [{ pid: 7, name: 'pythonw.exe', cmd: 'pythonw -m hermes_cli.main --profile taras gateway run', startedAt: new Date(startMs).toISOString() }] }, NOW, { readText: async (path) => files.get(path)!, modifiedAt: async () => null });
  assert.equal(up.status, 'up');

  const down = await probeHermesProfile(profile, auth, { ok: true, processes: [] }, NOW, { readText: async (path) => files.get(path)!, modifiedAt: async () => null });
  assert.equal(down.status, 'down');
  assert.equal(down.runtimeFailureConfirmed, true);
});

test('profile command matching is exact enough to reject a reused PID', () => {
  assert.equal(commandMatchesProfile('pythonw -m hermes_cli.main --profile ostap gateway run', 'ostap'), true);
  assert.equal(commandMatchesProfile('pythonw -m hermes_cli.main --profile=ostap gateway run', 'ostap'), true);
  assert.equal(commandMatchesProfile('pythonw -m hermes_cli.main --profile="ostap" gateway run', 'ostap'), true);
  assert.equal(commandMatchesProfile('pythonw -m hermes_cli.main --profile ostap-old gateway run', 'ostap'), false);
  assert.equal(commandMatchesProfile('pythonw -m hermes_cli.main --profile=ostap-old gateway run', 'ostap'), false);
  assert.equal(commandMatchesProfile('pythonw other.py --profile ostap', 'ostap'), false);
  assert.equal(commandMatchesProfile('pythonw other.py --profile ostap gateway run', 'ostap'), false);
});

test('an incomplete Windows process snapshot is unknown evidence, never an empty confirmed inventory', () => {
  assert.equal(parseHermesProcesses('{}').ok, false);
  assert.equal(parseHermesProcesses('{"processes":[]}').ok, true);
  assert.equal(parseHermesProcesses('{"processes":[{"pid":1}]}').ok, false);
});

test('decodes base64 command lines so C0 control characters cannot corrupt the process snapshot', () => {
  const command = 'pythonw -m hermes_cli.main --profile ostap gateway run\u001aignored';
  const result = parseHermesProcesses(JSON.stringify({ processes: [{
    pid: 91,
    name: 'pythonw.exe',
    cmdB64: Buffer.from(command, 'utf8').toString('base64'),
    startedAt: '2026-07-17T12:00:00.000Z',
  }] }));
  assert.equal(result.ok, true);
  assert.equal(result.processes[0]?.cmd, command);
});

test('a stale pidfile with a matching live gateway is degraded and never restart-eligible', async () => {
  const startMs = NOW - 20_000;
  const files = new Map([
    ['C:\\profiles\\ostap\\gateway.pid', JSON.stringify({ pid: 7, kind: 'hermes-gateway', argv: ['main.py', 'gateway', 'run'], start_time: startMs / 10 })],
    ['C:\\profiles\\ostap\\gateway_state.json', JSON.stringify({ pid: 7, kind: 'hermes-gateway', start_time: startMs / 10, gateway_state: 'running', platforms: {} })],
  ]);
  const result = await probeHermesProfile({
    id: 'ostap', label: 'ostap', home: 'C:\\profiles\\ostap', authFile: CONFIG.subscriptions[0]!.authFile,
    subscription: CONFIG.subscriptions[0]!, expectedPlatform: 'none', discoveryError: null,
  }, null, { ok: true, processes: [{
    pid: 8, name: 'pythonw.exe', cmd: 'pythonw -m hermes_cli.main --profile ostap gateway run', startedAt: new Date(startMs + 1000).toISOString(),
  }] }, NOW, { readText: async (path) => files.get(path)!, modifiedAt: async () => null });
  assert.equal(result.status, 'degraded');
  assert.equal(result.pid, 8);
  assert.equal(result.runtimeFailureConfirmed, false);
  assert.match(result.detail, /PID is stale/);
});

test('an alive PID with an unavailable command line is unknown and never restart-eligible', async () => {
  const startMs = NOW - 20_000;
  const files = new Map([
    ['C:\\profiles\\ostap\\gateway.pid', JSON.stringify({ pid: 7, kind: 'hermes-gateway', argv: ['main.py', 'gateway', 'run'], start_time: startMs / 10 })],
    ['C:\\profiles\\ostap\\gateway_state.json', JSON.stringify({ pid: 7, kind: 'hermes-gateway', start_time: startMs / 10, gateway_state: 'running', platforms: {} })],
  ]);
  const result = await probeHermesProfile({
    id: 'ostap', label: 'ostap', home: 'C:\\profiles\\ostap', authFile: CONFIG.subscriptions[0]!.authFile,
    subscription: CONFIG.subscriptions[0]!, expectedPlatform: 'none', discoveryError: null,
  }, null, { ok: true, processes: [{
    pid: 7, name: 'pythonw.exe', cmd: '', startedAt: new Date(startMs).toISOString(),
  }] }, NOW, { readText: async (path) => files.get(path)!, modifiedAt: async () => null });
  assert.equal(result.status, 'unknown');
  assert.equal(result.pid, 7);
  assert.equal(result.runtimeFailureConfirmed, false);
  assert.match(result.detail, /command line is unavailable/);
});

test('duplicate live gateways are degraded instead of a false healthy result', async () => {
  const startMs = NOW - 20_000;
  const files = new Map([
    ['C:\\profiles\\taras\\gateway.pid', JSON.stringify({ pid: 7, kind: 'hermes-gateway', argv: ['main.py', 'gateway', 'run'], start_time: startMs / 10 })],
    ['C:\\profiles\\taras\\gateway_state.json', JSON.stringify({ pid: 7, kind: 'hermes-gateway', start_time: startMs / 10, gateway_state: 'running', platforms: {} })],
  ]);
  const command = 'pythonw -m hermes_cli.main --profile taras gateway run';
  const result = await probeHermesProfile({
    id: 'taras', label: 'taras', home: 'C:\\profiles\\taras', authFile: CONFIG.subscriptions[0]!.authFile,
    subscription: CONFIG.subscriptions[0]!, expectedPlatform: 'none', discoveryError: null,
  }, null, { ok: true, processes: [
    { pid: 7, name: 'pythonw.exe', cmd: command, startedAt: new Date(startMs).toISOString() },
    { pid: 8, name: 'pythonw.exe', cmd: command, startedAt: new Date(startMs + 1000).toISOString() },
  ] }, NOW, { readText: async (path) => files.get(path)!, modifiedAt: async () => null });
  assert.equal(result.status, 'degraded');
  assert.equal(result.runtimeFailureConfirmed, false);
  assert.match(result.detail, /multiple gateway processes/);
});

test('a gateway older than its profile env is degraded until the new binding is loaded', async () => {
  const startMs = NOW - 20_000;
  const files = new Map([
    ['C:\\profiles\\alexey\\gateway.pid', JSON.stringify({ pid: 7, kind: 'hermes-gateway', argv: ['main.py', 'gateway', 'run'], start_time: startMs / 10 })],
    ['C:\\profiles\\alexey\\gateway_state.json', JSON.stringify({ pid: 7, kind: 'hermes-gateway', start_time: startMs / 10, gateway_state: 'running', platforms: { telegram: { state: 'connected' } } })],
  ]);
  const result = await probeHermesProfile({
    id: 'alexey', label: 'alexey', home: 'C:\\profiles\\alexey', authFile: CONFIG.subscriptions[0]!.authFile,
    subscription: CONFIG.subscriptions[0]!, expectedPlatform: 'telegram', discoveryError: null,
  }, null, { ok: true, processes: [{
    pid: 7, name: 'pythonw.exe', cmd: 'pythonw -m hermes_cli.main --profile alexey gateway run', startedAt: new Date(startMs).toISOString(),
  }] }, NOW, {
    readText: async (path) => files.get(path)!,
    modifiedAt: async (path) => path.endsWith('.env') ? startMs + 5_000 : null,
  });
  assert.equal(result.status, 'degraded');
  assert.equal(result.runtimeFailureConfirmed, false);
  assert.match(result.detail, /env changed after gateway start/);
});
