import type { AccountConfig, NormalizedUsage, Provider } from '../types.ts';

export function baseUsage(account: AccountConfig, provider: Provider, now: Date): NormalizedUsage {
  return {
    accountId: account.id,
    label: account.label,
    provider,
    session: null,
    weekly: null,
    weeklyOpus: null,
    fable: null,
    fableAccess: false,
    status: 'error',
    lastUpdated: now.toISOString(),
    error: null,
    retryAt: null,
  };
}
