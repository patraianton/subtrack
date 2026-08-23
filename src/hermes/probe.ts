import { readFile, readdir, stat } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import type { ServiceStatus } from '../ops/types.ts';
import type {
  DiscoveredHermesProfile,
  HermesCanaryResult,
  HermesMonitorConfig,
  HermesProcessSnapshot,
  HermesProfileHealth,
  HermesSubscriptionConfig,
  HermesSubscriptionHealth,
  HermesUsageProbe,
} from './types.ts';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const STATUS_RANK: Record<ServiceStatus, number> = { up: 0, degraded: 1, unknown: 2, down: 3 };

export interface HermesFileDeps {
  readText?: (path: string) => Promise<string>;
  listDirectories?: (path: string) => Promise<string[]>;
  isDirectory?: (path: string) => Promise<boolean>;
  modifiedAt?: (path: string) => Promise<number | null>;
}

const defaultReadText = (path: string) => readFile(path, 'utf8');
const defaultListDirectories = async (path: string): Promise<string[]> =>
  (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
const defaultIsDirectory = async (path: string): Promise<boolean> => {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
};
const defaultModifiedAt = async (path: string): Promise<number | null> => {
  try { return (await stat(path)).mtimeMs; } catch { return null; }
};

function cleanEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseProfileBinding(text: string): { authFile: string | null; telegramConfigured: boolean } {
  let authFile: string | null = null;
  let telegramConfigured = false;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1]!;
    const value = cleanEnvValue(match[2]!);
    if (key === 'HERMES_CODEX_AUTH_FILE') authFile = value || null;
    if (key === 'TELEGRAM_BOT_TOKEN') telegramConfigured = value.trim().length > 0;
  }
  return { authFile, telegramConfigured };
}

export function comparablePath(path: string): string {
  const normalized = normalize(resolve(path)).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function discoverHermesProfiles(config: HermesMonitorConfig, deps: HermesFileDeps = {}): Promise<DiscoveredHermesProfile[]> {
  const readText = deps.readText ?? defaultReadText;
  const listDirectories = deps.listDirectories ?? defaultListDirectories;
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;
  const profiles: DiscoveredHermesProfile[] = [];
  const byId = new Map(config.subscriptions.map((subscription) => [subscription.id, subscription]));
  const byPath = new Map(config.subscriptions.map((subscription) => [comparablePath(subscription.authFile), subscription]));
  let discoveredNames: string[] = [];
  try { discoveredNames = await listDirectories(config.profileRoot); }
  catch { /* configured expected profiles are still materialized below */ }
  const names = [...new Set([...discoveredNames, ...Object.keys(config.profileOverrides)])];
  for (const id of names.sort((a, b) => a.localeCompare(b))) {
    const override = config.profileOverrides[id];
    if (override?.enabled === false) continue;
    const home = join(config.profileRoot, id);
    const gatewayInstalled = await isDirectory(join(home, 'gateway-service'));
    if (!override && !gatewayInstalled) continue;
    let binding = { authFile: null as string | null, telegramConfigured: false };
    let discoveryError: string | null = override && !gatewayInstalled ? 'expected profile gateway-service is missing' : null;
    try { binding = parseProfileBinding(await readText(join(home, '.env'))); }
    catch (error) {
      const envError = `profile .env unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})`;
      discoveryError = discoveryError ? `${discoveryError}; ${envError}` : envError;
    }
    const subscription = override?.subscriptionId
      ? (byId.get(override.subscriptionId) ?? null)
      : (binding.authFile ? (byPath.get(comparablePath(binding.authFile)) ?? null) : null);
    profiles.push({
      id,
      label: override?.label ?? id,
      home,
      authFile: binding.authFile,
      subscription,
      expectedPlatform: override?.expectedPlatform ?? (binding.telegramConfigured ? 'telegram' : 'none'),
      discoveryError,
    });
  }
  return profiles;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const text = Buffer.from(part, 'base64url').toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function accountClaim(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const nested = payload['https://api.openai.com/auth'];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const value = (nested as Record<string, unknown>).chatgpt_account_id;
    if (typeof value === 'string' && value) return value;
  }
  for (const key of ['chatgpt_account_id', 'account_id']) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function accessExpiry(payload: Record<string, unknown> | null): string | null {
  const exp = payload?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : null;
}

export interface HermesAuthInspection {
  config: HermesSubscriptionConfig;
  /** Internal fail-closed gate for commands that may rotate the canonical credential. */
  ownerMutationSafe: boolean;
  status: ServiceStatus;
  detail: string;
  checkedAt: string;
  accountId: string | null;
  accessExpiresAt: string | null;
  lastRefreshAt: string | null;
  accessToken: string | null;
  usageProbe: HermesUsageProbe | null;
  canary: HermesCanaryResult | null;
}

export async function inspectHermesAuth(
  subscription: HermesSubscriptionConfig,
  now: number = Date.now(),
  readText: (path: string) => Promise<string> = defaultReadText,
): Promise<HermesAuthInspection> {
  const checkedAt = new Date(now).toISOString();
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(await readText(subscription.authFile)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    parsed = value as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      config: subscription, ownerMutationSafe: false, status: code === 'ENOENT' ? 'down' : 'unknown',
      detail: code === 'ENOENT' ? 'shared auth file missing' : 'shared auth file unreadable or malformed',
      checkedAt, accountId: null, accessExpiresAt: null, lastRefreshAt: null, accessToken: null,
      usageProbe: null, canary: null,
    };
  }
  const providers = parsed.providers;
  const provider = providers && typeof providers === 'object' && !Array.isArray(providers)
    ? (providers as Record<string, unknown>)['openai-codex'] : null;
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    return {
      config: subscription, ownerMutationSafe: false, status: 'down', detail: 'openai-codex shared credential missing', checkedAt,
      accountId: null, accessExpiresAt: null, lastRefreshAt: null, accessToken: null, usageProbe: null, canary: null,
    };
  }
  const record = provider as Record<string, unknown>;
  const tokensRaw = record.tokens;
  const tokens = tokensRaw && typeof tokensRaw === 'object' && !Array.isArray(tokensRaw) ? tokensRaw as Record<string, unknown> : {};
  const accountId = typeof record.account_id === 'string'
    ? record.account_id
    : (typeof tokens.account_id === 'string' ? tokens.account_id : null);
  const tokenAccountId = typeof tokens.account_id === 'string' ? tokens.account_id : null;
  const accessToken = typeof tokens.access_token === 'string' && tokens.access_token ? tokens.access_token : null;
  const refreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : null;
  const payload = accessToken ? decodeJwtPayload(accessToken) : null;
  const jwtAccountId = accountClaim(payload);
  const expiresAt = accessExpiry(payload);
  const lastRefreshAt = typeof record.last_refresh === 'string' ? record.last_refresh : null;
  const authError = record.last_auth_error;
  const reloginRequired = !!(authError && typeof authError === 'object' && !Array.isArray(authError)
    && (authError as Record<string, unknown>).relogin_required === true);
  const failures: string[] = [];
  const warnings: string[] = [];
  if (!accessToken) failures.push('access token missing');
  if (!refreshToken) failures.push('refresh token missing');
  if (!accountId) failures.push('account pin missing');
  else if (accountId !== subscription.expectedAccountId) failures.push('account pin mismatch');
  if (tokenAccountId && tokenAccountId !== subscription.expectedAccountId) failures.push('token account pin mismatch');
  if (jwtAccountId && jwtAccountId !== subscription.expectedAccountId) failures.push('access-token account mismatch');
  if (accessToken && !payload) warnings.push('access-token claims unreadable');
  else if (accessToken && !jwtAccountId) warnings.push('access-token account claim missing');
  if (!expiresAt && accessToken) warnings.push('access-token expiry unknown');
  else if (expiresAt && Date.parse(expiresAt) <= now) warnings.push('access token expired; refresh is available');
  if (reloginRequired) failures.push('credential requires login');
  const status: ServiceStatus = failures.length ? 'down' : warnings.length ? 'degraded' : 'up';
  const ownerMutationSafe = !!accessToken && !!refreshToken
    && accountId === subscription.expectedAccountId
    && (tokenAccountId === null || tokenAccountId === subscription.expectedAccountId)
    && jwtAccountId === subscription.expectedAccountId
    && !reloginRequired;
  return {
    config: subscription,
    ownerMutationSafe,
    status,
    detail: failures[0] ?? warnings[0] ?? 'shared OAuth credential is structurally valid',
    checkedAt,
    accountId,
    accessExpiresAt: expiresAt,
    lastRefreshAt,
    accessToken,
    usageProbe: null,
    canary: null,
  };
}

export async function probeHermesUsage(
  auth: HermesAuthInspection,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<HermesUsageProbe> {
  const checkedAt = new Date(now).toISOString();
  if (!auth.accessToken || !auth.accountId) return { status: 'down', detail: 'usage probe blocked by invalid shared auth', checkedAt, httpStatus: null };
  try {
    const response = await fetchImpl(USAGE_URL, {
      headers: { authorization: `Bearer ${auth.accessToken}`, 'chatgpt-account-id': auth.accountId },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 200) return { status: 'up', detail: 'live OpenAI auth probe passed', checkedAt, httpStatus: 200 };
    if (response.status === 429) return { status: 'up', detail: 'OpenAI accepted auth (usage rate limited)', checkedAt, httpStatus: 429 };
    if (response.status === 401 || response.status === 403) return { status: 'down', detail: `OpenAI rejected auth (HTTP ${response.status})`, checkedAt, httpStatus: response.status };
    return { status: 'degraded', detail: `OpenAI auth probe returned HTTP ${response.status}`, checkedAt, httpStatus: response.status };
  } catch {
    return { status: 'unknown', detail: 'OpenAI auth probe unavailable', checkedAt, httpStatus: null };
  }
}

export function publicSubscriptionHealth(auth: HermesAuthInspection): HermesSubscriptionHealth {
  const statuses = [auth.status, auth.usageProbe?.status, auth.canary?.status].filter((value): value is ServiceStatus => !!value);
  const status = statuses.reduce((worst, value) => STATUS_RANK[value] > STATUS_RANK[worst] ? value : worst, 'up' as ServiceStatus);
  const detail = status === 'down'
    ? (auth.status === 'down' ? auth.detail : auth.usageProbe?.status === 'down' ? auth.usageProbe.detail : auth.canary?.status === 'down' ? auth.canary.detail : auth.detail)
    : status === 'unknown'
      ? (auth.usageProbe?.status === 'unknown' ? auth.usageProbe.detail : auth.detail)
      : status === 'degraded'
        ? (auth.usageProbe?.status === 'degraded' ? auth.usageProbe.detail : auth.canary?.status === 'degraded' ? auth.canary.detail : auth.detail)
        : 'shared OAuth + live OpenAI probe OK';
  return {
    id: auth.config.id,
    label: auth.config.label,
    status,
    detail,
    checkedAt: auth.usageProbe?.checkedAt ?? auth.checkedAt,
    accessExpiresAt: auth.accessExpiresAt,
    lastRefreshAt: auth.lastRefreshAt,
    usageProbe: auth.usageProbe,
    canary: auth.canary,
  };
}

interface PidRecord { pid?: unknown; kind?: unknown; argv?: unknown; start_time?: unknown }
interface ValidPidRecord { pid: number; kind: 'hermes-gateway'; argv: string[]; start_time: number }
interface GatewayStateRecord extends PidRecord {
  gateway_state?: unknown;
  platforms?: unknown;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function commandMatchesProfile(command: string, profile: string): boolean {
  const escaped = regexEscape(profile);
  const profileArg = new RegExp(`(?:--profile(?:=|\\s+)|-p\\s+)(?:"${escaped}"|'${escaped}'|${escaped})(?:\\s|$)`, 'i');
  const hermesEntrypoint = /(?:^|\s)-m\s+hermes_cli\.main(?:\s|$)/i;
  return hermesEntrypoint.test(command) && profileArg.test(command)
    && /(?:^|\s)gateway\s+(?:run|restart)(?:\s|$)/i.test(command);
}

function validPidRecord(record: PidRecord | null): record is ValidPidRecord {
  return !!record && typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0
    && record.kind === 'hermes-gateway' && typeof record.start_time === 'number' && Number.isFinite(record.start_time)
    && Array.isArray(record.argv) && record.argv.includes('gateway') && record.argv.includes('run');
}

function mergeWorst(...statuses: ServiceStatus[]): ServiceStatus {
  return statuses.reduce((worst, value) => STATUS_RANK[value] > STATUS_RANK[worst] ? value : worst, 'up');
}

export async function probeHermesProfile(
  profile: DiscoveredHermesProfile,
  auth: HermesSubscriptionHealth | null,
  processSnapshot: HermesProcessSnapshot,
  now: number = Date.now(),
  deps: HermesFileDeps = {},
): Promise<HermesProfileHealth> {
  const readText = deps.readText ?? defaultReadText;
  const modifiedAt = deps.modifiedAt ?? defaultModifiedAt;
  const checkedAt = new Date(now).toISOString();
  const problems: Array<{ status: ServiceStatus; detail: string }> = [];
  if (profile.discoveryError) problems.push({ status: 'unknown', detail: profile.discoveryError });
  if (!profile.authFile) problems.push({ status: 'down', detail: 'HERMES_CODEX_AUTH_FILE is missing' });
  if (!profile.subscription) problems.push({ status: 'down', detail: 'shared auth is not assigned to a monitored subscription' });
  if (profile.authFile && profile.subscription
    && comparablePath(profile.authFile) !== comparablePath(profile.subscription.authFile)) {
    problems.push({ status: 'down', detail: 'profile .env points at the wrong canonical auth store' });
  }

  const plannedStopMtime = await modifiedAt(join(profile.home, '.gateway-planned-stop.json'));
  const envMtime = await modifiedAt(join(profile.home, '.env'));
  const plannedStop = plannedStopMtime !== null && now - plannedStopMtime <= 120_000;
  let pidRaw: string | null = null;
  let stateRaw: string | null = null;
  try { pidRaw = await readText(join(profile.home, 'gateway.pid')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push({ status: 'unknown', detail: 'gateway.pid unreadable' }); }
  try { stateRaw = await readText(join(profile.home, 'gateway_state.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push({ status: 'unknown', detail: 'gateway_state.json unreadable' }); }
  const pidRecord = pidRaw ? parseObject(pidRaw) as PidRecord | null : null;
  const stateRecord = stateRaw ? parseObject(stateRaw) as GatewayStateRecord | null : null;
  const recordValid = validPidRecord(pidRecord);
  const matchingProcesses = processSnapshot.processes.filter((process) => commandMatchesProfile(process.cmd, profile.id));
  let pid: number | null = recordValid ? pidRecord.pid : (matchingProcesses[0]?.pid ?? null);
  let gatewayState: string | null = typeof stateRecord?.gateway_state === 'string' ? stateRecord.gateway_state : null;
  let platformState: string | null = null;
  let runtimeFailureConfirmed = false;
  let runtimeStatus: ServiceStatus = 'up';
  let runtimeDetail = 'gateway running';
  let liveProcessStartedMs: number | null = null;

  if (!processSnapshot.ok) {
    runtimeStatus = 'unknown';
    runtimeDetail = 'Windows process snapshot unavailable';
  } else if (!recordValid) {
    if (matchingProcesses.length > 0) {
      runtimeStatus = 'degraded';
      runtimeDetail = 'gateway process exists but authoritative PID record is stale';
    } else if (plannedStop) {
      runtimeStatus = 'degraded';
      runtimeDetail = 'gateway is in a planned stop/restart window';
    } else {
      runtimeStatus = 'down';
      runtimeDetail = pidRaw ? 'gateway.pid is malformed' : 'gateway process is not running';
      runtimeFailureConfirmed = true;
      pid = null;
    }
  } else {
    const process = processSnapshot.processes.find((candidate) => candidate.pid === pidRecord.pid);
    if (!process) {
      if (matchingProcesses.length > 0) {
        runtimeStatus = 'degraded';
        runtimeDetail = 'authoritative gateway PID is stale; matching gateway process is alive';
        pid = matchingProcesses[0]!.pid;
      } else if (plannedStop) {
        runtimeStatus = 'degraded';
        runtimeDetail = 'gateway is in a planned stop/restart window';
      } else {
        runtimeStatus = 'down';
        runtimeDetail = 'gateway PID is not alive';
        runtimeFailureConfirmed = true;
        pid = null;
      }
    } else if (!process.cmd.trim()) {
      runtimeStatus = 'unknown';
      runtimeDetail = 'gateway process command line is unavailable';
    } else if (!commandMatchesProfile(process.cmd, profile.id)) {
      runtimeStatus = 'down';
      runtimeDetail = 'gateway PID belongs to another process/profile';
      // A live but unrecognized PID is conflicting evidence, not proof that it
      // is safe to mutate this profile. Keep automatic recovery fail-closed.
      runtimeFailureConfirmed = false;
      pid = matchingProcesses[0]?.pid ?? null;
    } else {
      const startedMs = process.startedAt ? Date.parse(process.startedAt) : NaN;
      const recordedMs = pidRecord.start_time * 10;
      if (!Number.isFinite(startedMs)) {
        runtimeStatus = 'unknown';
        runtimeDetail = 'gateway start time is unavailable';
      } else if (Math.abs(startedMs - recordedMs) > 2000) {
        liveProcessStartedMs = startedMs;
        runtimeStatus = 'degraded';
        runtimeDetail = 'gateway PID start time is stale; matching gateway process is alive';
        runtimeFailureConfirmed = false;
      } else if (!stateRecord) {
        liveProcessStartedMs = startedMs;
        runtimeStatus = 'unknown';
        runtimeDetail = stateRaw ? 'gateway_state.json is malformed' : 'gateway_state.json is missing';
      } else if (stateRecord.pid !== pidRecord.pid || stateRecord.start_time !== pidRecord.start_time || stateRecord.kind !== 'hermes-gateway') {
        liveProcessStartedMs = startedMs;
        runtimeStatus = 'degraded';
        runtimeDetail = 'gateway state record does not match the live process';
      } else if (gatewayState !== 'running') {
        liveProcessStartedMs = startedMs;
        runtimeStatus = 'degraded';
        runtimeDetail = `gateway state is ${gatewayState ?? 'unknown'}`;
      } else {
        liveProcessStartedMs = startedMs;
      }
    }
  }
  if (processSnapshot.ok && matchingProcesses.length > 1
    && runtimeStatus !== 'down' && runtimeStatus !== 'unknown') {
    runtimeStatus = 'degraded';
    runtimeDetail = 'multiple gateway processes match this profile';
    runtimeFailureConfirmed = false;
  }
  if (envMtime !== null && liveProcessStartedMs !== null && envMtime - liveProcessStartedMs > 2000
    && runtimeStatus !== 'down' && runtimeStatus !== 'unknown') {
    runtimeStatus = 'degraded';
    runtimeDetail = 'profile .env changed after gateway start; restart required';
    runtimeFailureConfirmed = false;
  }
  if (profile.discoveryError) runtimeFailureConfirmed = false;
  problems.push({ status: runtimeStatus, detail: runtimeDetail });

  if (profile.expectedPlatform === 'telegram') {
    const platforms = stateRecord?.platforms;
    const telegram = platforms && typeof platforms === 'object' && !Array.isArray(platforms)
      ? (platforms as Record<string, unknown>).telegram : null;
    platformState = telegram && typeof telegram === 'object' && !Array.isArray(telegram)
      && typeof (telegram as Record<string, unknown>).state === 'string'
      ? (telegram as Record<string, unknown>).state as string : null;
    if (platformState !== 'connected') problems.push({ status: 'degraded', detail: `Telegram is ${platformState ?? 'not connected'}` });
  }
  if (auth) {
    if (auth.status !== 'up') problems.push({ status: auth.status, detail: `${auth.label}: ${auth.detail}` });
  }
  const status = mergeWorst(...problems.map((problem) => problem.status));
  let detail: string;
  if (status === 'up') {
    detail = `gateway running; ${profile.expectedPlatform === 'telegram' ? 'Telegram connected' : 'CLI-only'}; ${auth?.label ?? 'auth'} OK`;
  } else {
    detail = problems.find((problem) => problem.status === status)?.detail ?? 'Hermes health check failed';
  }
  return {
    id: profile.id,
    label: profile.label,
    subscriptionId: profile.subscription?.id ?? null,
    subscriptionLabel: profile.subscription?.label ?? null,
    status,
    detail,
    checkedAt,
    pid,
    gatewayState,
    platformState,
    expectedPlatform: profile.expectedPlatform,
    consecutiveRuntimeFailures: 0,
    lastRestartAt: null,
    autoHeal: false,
    runtimeFailureConfirmed,
  };
}
