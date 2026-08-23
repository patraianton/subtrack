import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { configDir } from '../config.ts';
import type { ServiceHealth, ServiceStatus } from '../ops/types.ts';
import { runPwsh, type PwshRunner } from '../ops/windows.ts';
import { loadHermesConfig } from './config.ts';
import {
  discoverHermesProfiles,
  comparablePath,
  inspectHermesAuth,
  probeHermesProfile,
  probeHermesUsage,
  publicSubscriptionHealth,
  type HermesAuthInspection,
  type HermesFileDeps,
} from './probe.ts';
import { listHermesProcesses } from './windows.ts';
import type {
  HermesCanaryResult,
  HermesFleetSnapshot,
  HermesMonitorConfig,
  HermesMonitorEvent,
  HermesProfileHealth,
  HermesSubscriptionHealth,
  HermesUsageProbe,
} from './types.ts';

const RANK: Record<ServiceStatus, number> = { up: 0, degraded: 1, unknown: 2, down: 3 };

interface ProfileRuntimeState {
  consecutiveRuntimeFailures: number;
  lastRestartAt: string | null;
  restartAttempts: string[];
}

interface SubscriptionRuntimeState {
  lastProbe: HermesUsageProbe | null;
  lastCanary: HermesCanaryResult | null;
}

interface MonitorDiskState {
  version: 1;
  profiles: Record<string, ProfileRuntimeState>;
  subscriptions: Record<string, SubscriptionRuntimeState>;
  recentEvents: HermesMonitorEvent[];
}

interface LoadedMonitorState {
  state: MonitorDiskState;
  autoHealBlocked: boolean;
}

export interface HermesCommandResult { status: ServiceStatus; detail: string; checkedAt: string }

export interface HermesMonitorDeps extends HermesFileDeps {
  base?: string;
  config?: HermesMonitorConfig;
  now?: () => number;
  runPwsh?: PwshRunner;
  fetchImpl?: typeof fetch;
  restartProfile?: (profile: string, home: string, config: HermesMonitorConfig, now: number) => Promise<HermesCommandResult>;
  runCanary?: (profile: string, home: string, config: HermesMonitorConfig, now: number) => Promise<HermesCanaryResult>;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  processSnapshotTimeoutMs?: number;
}

async function bounded<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return await new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    timer.unref();
    void work.then(finish, () => finish(fallback));
  });
}

function statePath(base: string): string { return join(configDir(base), 'hermes-monitor-state.json'); }
function eventLogPath(base: string): string { return join(configDir(base), 'logs', 'hermes-monitor.jsonl'); }

function emptyState(): MonitorDiskState {
  return { version: 1, profiles: {}, subscriptions: {}, recentEvents: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isStatus(value: unknown): value is ServiceStatus {
  return value === 'up' || value === 'down' || value === 'degraded' || value === 'unknown';
}

function validProfileState(value: unknown): value is ProfileRuntimeState {
  if (!isRecord(value)) return false;
  return typeof value.consecutiveRuntimeFailures === 'number'
    && Number.isInteger(value.consecutiveRuntimeFailures) && value.consecutiveRuntimeFailures >= 0
    && (value.lastRestartAt === null || isTimestamp(value.lastRestartAt))
    && Array.isArray(value.restartAttempts) && value.restartAttempts.every(isTimestamp);
}

function validProbeState(value: unknown): value is HermesUsageProbe {
  return isRecord(value) && isStatus(value.status) && typeof value.detail === 'string' && isTimestamp(value.checkedAt)
    && (value.httpStatus === null || (typeof value.httpStatus === 'number' && Number.isInteger(value.httpStatus)));
}

function validCanaryState(value: unknown): value is HermesCanaryResult {
  return isRecord(value) && isStatus(value.status) && typeof value.detail === 'string' && isTimestamp(value.checkedAt);
}

function validSubscriptionState(value: unknown): value is SubscriptionRuntimeState {
  return isRecord(value)
    && (value.lastProbe === null || validProbeState(value.lastProbe))
    && (value.lastCanary === null || validCanaryState(value.lastCanary));
}

function validEvent(value: unknown): value is HermesMonitorEvent {
  return isRecord(value) && isTimestamp(value.at)
    && (value.level === 'info' || value.level === 'warning' || value.level === 'critical')
    && (value.scope === 'fleet' || value.scope === 'profile' || value.scope === 'subscription')
    && typeof value.id === 'string' && typeof value.message === 'string';
}

async function loadState(base: string): Promise<LoadedMonitorState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(base), 'utf8')) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.profiles) || !isRecord(parsed.subscriptions)
      || !Array.isArray(parsed.recentEvents)
      || !Object.values(parsed.profiles).every(validProfileState)
      || !Object.values(parsed.subscriptions).every(validSubscriptionState)
      || !parsed.recentEvents.every(validEvent)) throw new Error('invalid monitor state');
    return { state: {
      version: 1,
      profiles: parsed.profiles as Record<string, ProfileRuntimeState>,
      subscriptions: parsed.subscriptions as Record<string, SubscriptionRuntimeState>,
      recentEvents: (parsed.recentEvents as HermesMonitorEvent[]).slice(-50),
    }, autoHealBlocked: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: emptyState(), autoHealBlocked: false };
    return { state: emptyState(), autoHealBlocked: true };
  }
}

async function saveState(base: string, state: MonitorDiskState): Promise<void> {
  const directory = configDir(base);
  const target = statePath(base);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await rename(temporary, target);
  } catch (error) {
    try { await unlink(temporary); } catch { /* best-effort temp cleanup */ }
    throw error;
  }
}

export function sanitizeHermesDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{30,}(?:\.[A-Za-z0-9_-]+){0,2}\b/g, '[redacted-token]')
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)[^"',;\s}]+/gi, '$1[redacted]')
    .replace(/(\b[A-Z0-9_]*(?:TOKEN|SECRET|API_KEY)\b\s*=\s*)[^\s;&]+/g, '$1[redacted]')
    .replace(/([?&](?:access_token|refresh_token|id_token|api_key)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|rk|rt|sess)[-_][A-Za-z0-9._-]{8,}\b/gi, '[redacted-token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-300);
}

function execHermes(command: string, args: string[], home: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      cwd: home,
      env: { ...process.env, HERMES_HOME: home, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
    }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
        ? (error as NodeJS.ErrnoException & { code: number }).code : (error ? 1 : 0);
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    child.unref();
  });
}

export async function restartHermesProfile(profile: string, home: string, config: HermesMonitorConfig, now: number): Promise<HermesCommandResult> {
  const checkedAt = new Date(now).toISOString();
  const result = await execHermes(config.hermesCommand, ['--profile', profile, 'gateway', 'restart'], home, 120_000);
  if (result.code === 0) return { status: 'up', detail: 'safe Hermes restart completed', checkedAt };
  return { status: 'down', detail: `Hermes restart failed (exit ${result.code})`, checkedAt };
}

export async function runHermesCanary(profile: string, home: string, config: HermesMonitorConfig, now: number): Promise<HermesCanaryResult> {
  const checkedAt = new Date(now).toISOString();
  const marker = 'HERMES_MONITOR_OK';
  const result = await execHermes(
    config.hermesCommand,
    ['--profile', profile, '--ignore-rules', '--oneshot', `Reply with exactly: ${marker}`],
    home,
    180_000,
  );
  if (result.code === 0 && result.stdout.trim() === marker) return { status: 'up', detail: 'real model canary passed', checkedAt };
  const diagnostic = `${result.stderr}\n${result.stdout}`;
  const isAuth = /token_invalidated|token_revoked|invalid_grant|refresh_token_reused|codex_account_mismatch|\b401\b|\b403\b/i.test(diagnostic);
  const detail = isAuth
    ? 'real model canary hit an auth failure'
    : result.code === 0 ? 'real model canary returned an unexpected response' : `real model canary failed (exit ${result.code})`;
  return { status: isAuth ? 'down' : 'degraded', detail, checkedAt };
}

function worstStatus(statuses: ServiceStatus[]): ServiceStatus {
  if (statuses.length === 0) return 'unknown';
  return statuses.reduce((worst, status) => RANK[status] > RANK[worst] ? status : worst, 'up');
}

function isoAgeMs(value: string | null | undefined, now: number): number {
  if (!value) return Infinity;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : Infinity;
}

function profileState(state: MonitorDiskState, id: string): ProfileRuntimeState {
  const current = state.profiles[id];
  if (current && typeof current.consecutiveRuntimeFailures === 'number' && Array.isArray(current.restartAttempts)) return current;
  const created: ProfileRuntimeState = { consecutiveRuntimeFailures: 0, lastRestartAt: null, restartAttempts: [] };
  state.profiles[id] = created;
  return created;
}

function subscriptionState(state: MonitorDiskState, id: string): SubscriptionRuntimeState {
  const current = state.subscriptions[id];
  if (current) return current;
  const created: SubscriptionRuntimeState = { lastProbe: null, lastCanary: null };
  state.subscriptions[id] = created;
  return created;
}

function isProbeDue(previous: HermesUsageProbe | null, seconds: number, now: number): boolean {
  return !previous || isoAgeMs(previous.checkedAt, now) >= seconds * 1000;
}

function isCanaryDue(previous: HermesCanaryResult | null, config: HermesMonitorConfig, now: number): boolean {
  if (!previous) return true;
  const seconds = previous.status === 'up' ? config.canarySeconds : config.canaryRetrySeconds;
  return isoAgeMs(previous.checkedAt, now) >= seconds * 1000;
}

function transitionLevel(status: ServiceStatus): HermesMonitorEvent['level'] {
  if (status === 'down') return 'critical';
  if (status === 'degraded' || status === 'unknown') return 'warning';
  return 'info';
}

export class HermesFleetMonitor {
  private readonly base: string;
  private readonly config: HermesMonitorConfig;
  private readonly deps: HermesMonitorDeps;
  private readonly autoHealBlocked: boolean;
  private state: MonitorDiskState;
  private snapshot: HermesFleetSnapshot;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;

  private constructor(config: HermesMonitorConfig, state: MonitorDiskState, autoHealBlocked: boolean, deps: HermesMonitorDeps) {
    this.base = deps.base ?? homedir();
    this.config = config;
    this.deps = deps;
    this.state = state;
    this.autoHealBlocked = autoHealBlocked;
    this.snapshot = {
      enabled: config.enabled,
      status: config.enabled ? 'unknown' : 'unknown',
      detail: autoHealBlocked ? 'Hermes state unreadable; automatic recovery is fail-closed until restart'
        : config.enabled ? 'first Hermes fleet check pending' : 'Hermes monitor disabled',
      generatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      profiles: [],
      subscriptions: [],
      recentEvents: state.recentEvents.slice(-20),
    };
  }

  static async create(deps: HermesMonitorDeps = {}): Promise<HermesFleetMonitor | null> {
    const base = deps.base ?? homedir();
    const config = deps.config ?? await loadHermesConfig(base);
    if (!config || !config.enabled) return null;
    const loaded = await loadState(base);
    if (loaded.autoHealBlocked) loaded.state.recentEvents.push({
      at: new Date((deps.now ?? Date.now)()).toISOString(), level: 'critical', scope: 'fleet', id: 'fleet',
      message: 'monitor state was unreadable; automatic recovery blocked for this process',
    });
    return new HermesFleetMonitor(config, loaded.state, loaded.autoHealBlocked, { ...deps, base });
  }

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    const setTimer = this.deps.setIntervalImpl ?? setInterval;
    this.timer = setTimer(() => { void this.runOnce(); }, this.config.checkIntervalSeconds * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    (this.deps.clearIntervalImpl ?? clearInterval)(this.timer);
    this.timer = null;
  }

  getSnapshot(): HermesFleetSnapshot { return this.snapshot; }

  serviceRows(): ServiceHealth[] {
    const rows: ServiceHealth[] = [{
      id: 'hermes-fleet', label: 'Hermes fleet', kind: 'hermes', alwaysOn: true, group: 'Hermes fleet',
      status: this.snapshot.status, detail: this.snapshot.detail, pid: null, lastRun: null, nextRun: null,
      checkedAt: this.snapshot.generatedAt, autoHeal: this.config.autoRestart && !this.autoHealBlocked,
    }];
    for (const subscription of this.snapshot.subscriptions) {
      rows.push({
        id: `hermes-auth-${subscription.id}`, label: subscription.label, kind: 'hermes', alwaysOn: true, group: 'Hermes auth',
        status: subscription.status, detail: subscription.detail, pid: null, lastRun: null, nextRun: null,
        checkedAt: subscription.checkedAt, subscription: subscription.label, autoHeal: false,
      });
    }
    for (const profile of this.snapshot.profiles) {
      rows.push({
        id: `hermes-${profile.id}`, label: profile.label, kind: 'hermes', alwaysOn: true,
        group: `Hermes · ${profile.subscriptionLabel ?? 'unassigned'}`,
        status: profile.status, detail: profile.detail, pid: profile.pid, lastRun: null, nextRun: null,
        checkedAt: profile.checkedAt, subscription: profile.subscriptionLabel ?? undefined,
        autoHeal: profile.autoHeal, lastRestartAt: profile.lastRestartAt,
        consecutiveFailures: profile.consecutiveRuntimeFailures,
      });
    }
    return rows;
  }

  runOnce(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.performCheck().catch(async (error) => {
      const now = (this.deps.now ?? Date.now)();
      await this.recordEvent({ at: new Date(now).toISOString(), level: 'critical', scope: 'fleet', id: 'fleet', message: `monitor check failed: ${sanitizeHermesDiagnostic(String((error as Error).message))}` });
      this.snapshot = { ...this.snapshot, status: 'unknown', detail: 'Hermes monitor check failed', generatedAt: new Date(now).toISOString(), recentEvents: this.state.recentEvents.slice(-20) };
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async runOwnedCanary(
    selected: { id: string; home: string },
    runtime: SubscriptionRuntimeState,
    now: number,
  ): Promise<HermesCanaryResult> {
    runtime.lastCanary = {
      status: 'unknown', detail: 'real model canary started; result pending', checkedAt: new Date(now).toISOString(),
    };
    // The canary is the sole credential-owner path and may rotate a refresh
    // token. Reserve its retry window before invoking Hermes so a crash cannot
    // immediately repeat the mutation.
    await saveState(this.base, this.state);
    const result = await (this.deps.runCanary ?? runHermesCanary)(selected.id, selected.home, this.config, now);
    runtime.lastCanary = result;
    return result;
  }

  private async performCheck(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const previous = this.snapshot;
    const run = this.deps.runPwsh ?? runPwsh;
    const [profiles, processes, initialAuth] = await Promise.all([
      discoverHermesProfiles(this.config, this.deps),
      bounded(listHermesProcesses(run), this.deps.processSnapshotTimeoutMs ?? 20_000, {
        ok: false, processes: [], error: 'process snapshot timed out',
      }),
      Promise.all(this.config.subscriptions.map((subscription) => inspectHermesAuth(subscription, now, this.deps.readText))),
    ]);
    const authById = new Map<string, HermesAuthInspection>();
    for (let auth of initialAuth) {
      const runtime = subscriptionState(this.state, auth.config.id);
      const candidates = profiles.filter((profile) => profile.subscription?.id === auth.config.id);
      const selected = candidates.find((profile) => profile.id === auth.config.probeProfile) ?? candidates[0];
      const selectedBindingSafe = !!selected && selected.discoveryError === null && !!selected.authFile
        && comparablePath(selected.authFile) === comparablePath(auth.config.authFile);
      const ownerActionSafe = !this.autoHealBlocked && auth.ownerMutationSafe && selectedBindingSafe;
      const canaryDue = !!selected && isCanaryDue(runtime.lastCanary, this.config, now);
      if (canaryDue && selected && ownerActionSafe) {
        await this.runOwnedCanary(selected, runtime, now);
        auth = await inspectHermesAuth(auth.config, now, this.deps.readText);
      }
      if (isProbeDue(runtime.lastProbe, this.config.authProbeSeconds, now)) {
        runtime.lastProbe = await probeHermesUsage(auth, this.deps.fetchImpl ?? fetch, now);
      }
      if (runtime.lastProbe?.status === 'down' && selected && ownerActionSafe && !canaryDue
        && isoAgeMs(runtime.lastCanary?.checkedAt, now) >= this.config.canaryRetrySeconds * 1000) {
        await this.runOwnedCanary(selected, runtime, now);
        auth = await inspectHermesAuth(auth.config, now, this.deps.readText);
        runtime.lastProbe = await probeHermesUsage(auth, this.deps.fetchImpl ?? fetch, now);
      }
      auth.usageProbe = runtime.lastProbe;
      auth.canary = runtime.lastCanary;
      authById.set(auth.config.id, auth);
    }
    const subscriptions = this.config.subscriptions.map((subscription) => publicSubscriptionHealth(authById.get(subscription.id)!));
    const publicAuthById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
    const checkedProfiles = await Promise.all(profiles.map((profile) => probeHermesProfile(
      profile,
      profile.subscription ? (publicAuthById.get(profile.subscription.id) ?? null) : null,
      processes,
      now,
      this.deps,
    )));
    const restart = this.deps.restartProfile ?? restartHermesProfile;
    for (const profile of checkedProfiles) {
      const runtime = profileState(this.state, profile.id);
      if (profile.runtimeFailureConfirmed) runtime.consecutiveRuntimeFailures += 1;
      else if (profile.pid !== null && profile.gatewayState === 'running') runtime.consecutiveRuntimeFailures = 0;
      runtime.restartAttempts = runtime.restartAttempts.filter((at) => isoAgeMs(at, now) < 3_600_000);
      profile.consecutiveRuntimeFailures = runtime.consecutiveRuntimeFailures;
      profile.lastRestartAt = runtime.lastRestartAt;
      profile.autoHeal = this.config.autoRestart && !this.autoHealBlocked;
      const cooldownReady = isoAgeMs(runtime.lastRestartAt, now) >= this.config.restartCooldownSeconds * 1000;
      const rateReady = runtime.restartAttempts.length < this.config.maxRestartsPerHour;
      const discovered = profiles.find((candidate) => candidate.id === profile.id)!;
      const privateAuth = discovered.subscription ? authById.get(discovered.subscription.id) : undefined;
      const publicAuth = discovered.subscription ? publicAuthById.get(discovered.subscription.id) : undefined;
      const exactOwnerBinding = discovered.discoveryError === null && !!discovered.authFile && !!discovered.subscription
        && comparablePath(discovered.authFile) === comparablePath(discovered.subscription.authFile);
      const recoveryOwnerSafe = exactOwnerBinding && privateAuth?.ownerMutationSafe === true && publicAuth?.status !== 'down';
      if (this.config.autoRestart && !this.autoHealBlocked && recoveryOwnerSafe && profile.runtimeFailureConfirmed
        && runtime.consecutiveRuntimeFailures >= this.config.restartAfterFailures && cooldownReady && rateReady) {
        const attemptAt = new Date(now).toISOString();
        runtime.lastRestartAt = attemptAt;
        runtime.restartAttempts.push(attemptAt);
        profile.lastRestartAt = attemptAt;
        // Persist the cooldown/rate-limit reservation before any webhook or
        // external Hermes action. A crash must fail closed against a repeat.
        await saveState(this.base, this.state);
        await this.recordEvent({ at: attemptAt, level: 'warning', scope: 'profile', id: profile.id, message: 'confirmed runtime outage; starting safe Hermes restart' });
        const result = await restart(profile.id, discovered.home, this.config, now);
        if (result.status === 'up') {
          runtime.consecutiveRuntimeFailures = 0;
          profile.consecutiveRuntimeFailures = 0;
          profile.status = 'degraded';
          profile.detail = 'auto-restart completed; awaiting the next independent health check';
          await this.recordEvent({ at: result.checkedAt, level: 'info', scope: 'profile', id: profile.id, message: result.detail });
        } else {
          profile.status = 'down';
          profile.detail = `auto-restart failed: ${result.detail}`;
          await this.recordEvent({ at: result.checkedAt, level: 'critical', scope: 'profile', id: profile.id, message: profile.detail });
        }
      }
    }
    const statuses = [...subscriptions.map((subscription) => subscription.status), ...checkedProfiles.map((profile) => profile.status)];
    const status = worstStatus(this.autoHealBlocked ? [...statuses, 'degraded'] : statuses);
    const profileUp = checkedProfiles.filter((profile) => profile.status === 'up').length;
    const authUp = subscriptions.filter((subscription) => subscription.status === 'up').length;
    const snapshot: HermesFleetSnapshot = {
      enabled: true,
      status,
      detail: `${profileUp}/${checkedProfiles.length} profiles healthy; ${authUp}/${subscriptions.length} shared auth healthy${this.autoHealBlocked ? '; automatic recovery blocked by unreadable state' : ''}`,
      generatedAt: new Date(now).toISOString(),
      profiles: checkedProfiles.sort((a, b) => (a.subscriptionLabel ?? '').localeCompare(b.subscriptionLabel ?? '') || a.label.localeCompare(b.label)),
      subscriptions,
      recentEvents: this.state.recentEvents.slice(-20),
    };
    await this.recordTransitions(previous, snapshot);
    snapshot.recentEvents = this.state.recentEvents.slice(-20);
    this.snapshot = snapshot;
    await saveState(this.base, this.state);
    await this.sendHeartbeat(snapshot);
  }

  private async recordTransitions(previous: HermesFleetSnapshot, next: HermesFleetSnapshot): Promise<void> {
    const at = next.generatedAt;
    if (previous.profiles.length === 0 && previous.subscriptions.length === 0) {
      await this.recordEvent({ at, level: transitionLevel(next.status), scope: 'fleet', id: 'fleet', message: `initial check: ${next.detail}` });
      return;
    }
    const oldProfiles = new Map(previous.profiles.map((profile) => [profile.id, profile]));
    for (const profile of next.profiles) {
      const before = oldProfiles.get(profile.id);
      if (!before || before.status === profile.status) continue;
      await this.recordEvent({ at, level: transitionLevel(profile.status), scope: 'profile', id: profile.id, message: `${before.status} -> ${profile.status}: ${profile.detail}` });
    }
    const oldSubscriptions = new Map(previous.subscriptions.map((subscription) => [subscription.id, subscription]));
    for (const subscription of next.subscriptions) {
      const before = oldSubscriptions.get(subscription.id);
      if (!before || before.status === subscription.status) continue;
      await this.recordEvent({ at, level: transitionLevel(subscription.status), scope: 'subscription', id: subscription.id, message: `${before.status} -> ${subscription.status}: ${subscription.detail}` });
    }
  }

  private async recordEvent(event: HermesMonitorEvent): Promise<void> {
    const safe = { ...event, message: sanitizeHermesDiagnostic(event.message) };
    this.state.recentEvents.push(safe);
    this.state.recentEvents = this.state.recentEvents.slice(-50);
    try {
      await mkdir(join(configDir(this.base), 'logs'), { recursive: true });
      await appendFile(eventLogPath(this.base), `${JSON.stringify(safe)}\n`, 'utf8');
    } catch { /* monitoring continues even if the incident log is unavailable */ }
    if (this.config.alertWebhookUrl) await this.postWebhook(this.config.alertWebhookUrl, { source: 'subtrack-hermes', event: safe });
  }

  private async sendHeartbeat(snapshot: HermesFleetSnapshot): Promise<void> {
    if (!this.config.heartbeatUrl) return;
    await this.postWebhook(this.config.heartbeatUrl, {
      source: 'subtrack-hermes', at: snapshot.generatedAt, ok: snapshot.status === 'up', status: snapshot.status,
      profiles: { healthy: snapshot.profiles.filter((profile) => profile.status === 'up').length, total: snapshot.profiles.length },
      subscriptions: { healthy: snapshot.subscriptions.filter((subscription) => subscription.status === 'up').length, total: snapshot.subscriptions.length },
    });
  }

  private async postWebhook(url: string, body: unknown): Promise<void> {
    try {
      await (this.deps.fetchImpl ?? fetch)(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
    } catch { /* heartbeat/alert transport must never stop local monitoring */ }
  }
}
