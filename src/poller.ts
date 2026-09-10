import type { AccountConfig, NormalizedUsage, SubtrackConfig } from './types.ts';
import type { SnapshotStore } from './snapshotStore.ts';

const BACKOFF_MINUTES = [5, 10, 15];
const STAGGER_MS = 7_000;
const AUTH_ERROR_PAUSE_MS = 15 * 60_000;
// Ceiling for a provider-supplied Retry-After: honour a long wait, but never let one header park
// an account for hours (a card that stops updating all evening is worse than one extra request).
const MAX_THROTTLE_MS = 60 * 60_000;

export interface PollerDeps {
  config: SubtrackConfig;
  fetchUsage(account: AccountConfig): Promise<NormalizedUsage>;
  store: SnapshotStore;
  clock?: () => number;
  tickMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

interface AccountState { nextAt: number; step: number }

export class Poller {
  private readonly state = new Map<string, AccountState>();
  private readonly clock: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: PollerDeps) {
    this.clock = deps.clock ?? Date.now;
    const now = this.clock();
    let i = 0;
    for (const acc of this.enabled()) {
      this.state.set(acc.id, { nextAt: now + i * STAGGER_MS, step: 0 });
      i++;
    }
  }

  private enabled(): AccountConfig[] {
    return this.deps.config.accounts.filter((a) => a.enabled);
  }

  private ttlMs(provider: AccountConfig['provider']): number {
    return this.deps.config.pollIntervalSeconds[provider] * 1000;
  }

  due(now: number = this.clock()): AccountConfig[] {
    return this.enabled().filter((a) => {
      const st = this.state.get(a.id);
      return !st || now >= st.nextAt;
    });
  }

  async tick(now: number = this.clock()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const acc of this.due(now)) {
        let usage: NormalizedUsage;
        try {
          usage = await this.deps.fetchUsage(acc);
        } catch (e) {
          usage = { accountId: acc.id, label: acc.label, provider: acc.provider, session: null, weekly: null, weeklyOpus: null, fable: null, fableAccess: false, status: 'error', lastUpdated: new Date(now).toISOString(), error: e instanceof Error ? e.message : String(e), retryAt: null };
        }
        // Never blank the dashboard: on any non-ok result, carry forward the last-known windows.
        if (usage.status !== 'ok') {
          const prior = this.deps.store.get(acc.id);
          if (prior) {
            usage.session = prior.session;
            usage.weekly = prior.weekly;
            usage.weeklyOpus = prior.weeklyOpus;
            usage.fable = prior.fable;
            usage.fableAccess = prior.fableAccess; // keep the known access fact visible through errors
          }
        }
        this.applyBackoff(acc, usage, now);
        this.deps.store.set(acc.id, usage);
      }
    } finally {
      this.running = false;
    }
  }

  private applyBackoff(acc: AccountConfig, usage: NormalizedUsage, now: number): void {
    const st = this.state.get(acc.id) ?? { nextAt: 0, step: 0 };
    if (usage.status === 'throttled') {
      const mins = BACKOFF_MINUTES[Math.min(st.step, BACKOFF_MINUTES.length - 1)]!;
      st.step += 1;
      // The adapter passes the provider's own Retry-After through as retryAt. When the provider
      // asks for longer than our ladder, it wins: Anthropic answers a rate-limited account with
      // ~33 minutes, and retrying every 5 just re-hits a closed door (and can extend the block),
      // while the card sits on a "retry in 3m" countdown that never comes true.
      const asked = usage.retryAt ? Date.parse(usage.retryAt) : NaN;
      const askedAt = Number.isFinite(asked) ? Math.min(asked, now + MAX_THROTTLE_MS) : 0;
      st.nextAt = Math.max(now + mins * 60_000, askedAt);
      usage.retryAt = new Date(st.nextAt).toISOString();
    } else if (usage.status === 'auth_error') {
      st.step = 0;
      st.nextAt = now + AUTH_ERROR_PAUSE_MS; // known-bad token — back off long, don't hammer every TTL
      usage.retryAt = new Date(st.nextAt).toISOString();
    } else {
      st.step = 0;
      st.nextAt = now + this.ttlMs(acc.provider);
    }
    this.state.set(acc.id, st);
  }

  start(): void {
    if (this.timer) return;
    const setI = this.deps.setIntervalImpl ?? setInterval;
    const tickMs = this.deps.tickMs ?? 5_000;
    void this.tick();
    this.timer = setI(() => void this.tick(), tickMs);
  }

  stop(): void {
    const clearI = this.deps.clearIntervalImpl ?? clearInterval;
    if (this.timer) { clearI(this.timer); this.timer = null; }
  }
}
