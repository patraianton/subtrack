import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { configDir } from '../config.ts';
import type {
  HermesExpectedPlatform,
  HermesMonitorConfig,
  HermesProfileOverride,
  HermesSubscriptionConfig,
} from './types.ts';

export function hermesConfigPath(base: string = homedir()): string {
  return join(configDir(base), 'hermes.json');
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`hermes.json: ${field} must be a non-empty string`);
  return value;
}

function optionalUrl(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = requiredString(value, field);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`hermes.json: ${field} must be an absolute http(s) URL`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`hermes.json: ${field} must use http or https`);
  return raw;
}

function parseSubscriptions(value: unknown): HermesSubscriptionConfig[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('hermes.json: subscriptions must be a non-empty array');
  const ids = new Set<string>();
  const authFiles = new Set<string>();
  const accountIds = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`hermes.json: subscriptions[${index}] must be an object`);
    const raw = item as Record<string, unknown>;
    const id = requiredString(raw.id, `subscriptions[${index}].id`);
    if (ids.has(id)) throw new Error(`hermes.json: duplicate subscription id "${id}"`);
    ids.add(id);
    const authFile = requiredString(raw.authFile, `subscriptions[${index}].authFile`);
    const authKey = authFile.replace(/\\/g, '/').toLowerCase();
    if (authFiles.has(authKey)) throw new Error(`hermes.json: duplicate subscription authFile "${authFile}"`);
    authFiles.add(authKey);
    const expectedAccountId = requiredString(raw.expectedAccountId, `subscriptions[${index}].expectedAccountId`);
    if (accountIds.has(expectedAccountId)) throw new Error(`hermes.json: duplicate expectedAccountId for subscription "${id}"`);
    accountIds.add(expectedAccountId);
    return {
      id,
      label: requiredString(raw.label, `subscriptions[${index}].label`),
      authFile,
      expectedAccountId,
      probeProfile: typeof raw.probeProfile === 'string' && raw.probeProfile.trim() ? raw.probeProfile : undefined,
    };
  });
}

function parseOverrides(value: unknown, subscriptionIds: Set<string>): Record<string, HermesProfileOverride> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('hermes.json: profileOverrides must be an object');
  const out: Record<string, HermesProfileOverride> = {};
  for (const [profile, item] of Object.entries(value as Record<string, unknown>)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`hermes.json: profileOverrides.${profile} must be an object`);
    const raw = item as Record<string, unknown>;
    const expectedPlatform = raw.expectedPlatform;
    if (expectedPlatform !== undefined && expectedPlatform !== 'telegram' && expectedPlatform !== 'none') {
      throw new Error(`hermes.json: profileOverrides.${profile}.expectedPlatform must be telegram or none`);
    }
    if (raw.subscriptionId !== undefined && (typeof raw.subscriptionId !== 'string' || !subscriptionIds.has(raw.subscriptionId))) {
      throw new Error(`hermes.json: profileOverrides.${profile}.subscriptionId is unknown`);
    }
    out[profile] = {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label : undefined,
      subscriptionId: typeof raw.subscriptionId === 'string' ? raw.subscriptionId : undefined,
      expectedPlatform: expectedPlatform as HermesExpectedPlatform | undefined,
    };
  }
  return out;
}

export async function loadHermesConfig(base: string = homedir()): Promise<HermesMonitorConfig | null> {
  let rawText: string;
  try { rawText = await readFile(hermesConfigPath(base), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('hermes.json must contain an object');
  if (parsed.version !== undefined && parsed.version !== 1) throw new Error('hermes.json: unsupported version');
  const subscriptions = parseSubscriptions(parsed.subscriptions);
  const profileOverrides = parseOverrides(parsed.profileOverrides, new Set(subscriptions.map((s) => s.id)));
  return {
    version: 1,
    enabled: parsed.enabled !== false,
    profileRoot: requiredString(parsed.profileRoot, 'profileRoot'),
    hermesCommand: requiredString(parsed.hermesCommand, 'hermesCommand'),
    checkIntervalSeconds: finiteNumber(parsed.checkIntervalSeconds, 120, 30, 3600),
    authProbeSeconds: finiteNumber(parsed.authProbeSeconds, 300, 60, 86_400),
    canarySeconds: finiteNumber(parsed.canarySeconds, 21_600, 900, 604_800),
    canaryRetrySeconds: finiteNumber(parsed.canaryRetrySeconds, 1800, 300, 86_400),
    restartAfterFailures: Math.round(finiteNumber(parsed.restartAfterFailures, 2, 2, 10)),
    restartCooldownSeconds: finiteNumber(parsed.restartCooldownSeconds, 1800, 60, 86_400),
    maxRestartsPerHour: Math.round(finiteNumber(parsed.maxRestartsPerHour, 3, 1, 12)),
    autoRestart: parsed.autoRestart !== false,
    heartbeatUrl: optionalUrl(parsed.heartbeatUrl, 'heartbeatUrl'),
    alertWebhookUrl: optionalUrl(parsed.alertWebhookUrl, 'alertWebhookUrl'),
    subscriptions,
    profileOverrides,
  };
}
