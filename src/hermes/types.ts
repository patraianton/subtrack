import type { ServiceStatus } from '../ops/types.ts';

export type HermesExpectedPlatform = 'telegram' | 'none';

export interface HermesSubscriptionConfig {
  id: string;
  label: string;
  authFile: string;
  expectedAccountId: string;
  probeProfile?: string;
}

export interface HermesProfileOverride {
  enabled?: boolean;
  label?: string;
  subscriptionId?: string;
  expectedPlatform?: HermesExpectedPlatform;
}

export interface HermesMonitorConfig {
  version: 1;
  enabled: boolean;
  profileRoot: string;
  hermesCommand: string;
  checkIntervalSeconds: number;
  authProbeSeconds: number;
  canarySeconds: number;
  canaryRetrySeconds: number;
  restartAfterFailures: number;
  restartCooldownSeconds: number;
  maxRestartsPerHour: number;
  autoRestart: boolean;
  heartbeatUrl?: string;
  alertWebhookUrl?: string;
  subscriptions: HermesSubscriptionConfig[];
  profileOverrides: Record<string, HermesProfileOverride>;
}

export interface HermesProcessInfo {
  pid: number;
  name: string;
  cmd: string;
  startedAt: string | null;
}

export interface HermesProcessSnapshot {
  ok: boolean;
  processes: HermesProcessInfo[];
  error?: string;
}

export interface DiscoveredHermesProfile {
  id: string;
  label: string;
  home: string;
  authFile: string | null;
  subscription: HermesSubscriptionConfig | null;
  expectedPlatform: HermesExpectedPlatform;
  discoveryError: string | null;
}

export interface HermesUsageProbe {
  status: ServiceStatus;
  detail: string;
  checkedAt: string;
  httpStatus: number | null;
}

export interface HermesCanaryResult {
  status: ServiceStatus;
  detail: string;
  checkedAt: string;
}

export interface HermesSubscriptionHealth {
  id: string;
  label: string;
  status: ServiceStatus;
  detail: string;
  checkedAt: string;
  accessExpiresAt: string | null;
  lastRefreshAt: string | null;
  usageProbe: HermesUsageProbe | null;
  canary: HermesCanaryResult | null;
}

export interface HermesProfileHealth {
  id: string;
  label: string;
  subscriptionId: string | null;
  subscriptionLabel: string | null;
  status: ServiceStatus;
  detail: string;
  checkedAt: string;
  pid: number | null;
  gatewayState: string | null;
  platformState: string | null;
  expectedPlatform: HermesExpectedPlatform;
  consecutiveRuntimeFailures: number;
  lastRestartAt: string | null;
  autoHeal: boolean;
  /** Internal decision signal. It is deliberately omitted from Services API rows. */
  runtimeFailureConfirmed: boolean;
}

export interface HermesMonitorEvent {
  at: string;
  level: 'info' | 'warning' | 'critical';
  scope: 'fleet' | 'profile' | 'subscription';
  id: string;
  message: string;
}

export interface HermesFleetSnapshot {
  enabled: boolean;
  status: ServiceStatus;
  detail: string;
  generatedAt: string;
  profiles: HermesProfileHealth[];
  subscriptions: HermesSubscriptionHealth[];
  recentEvents: HermesMonitorEvent[];
}
