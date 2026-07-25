import type { ServiceHealth } from '../ops/types.ts';

export interface SupervisedHermesMonitor {
  start(): void;
  stop(): void;
  serviceRows(): ServiceHealth[];
}

export interface HermesMonitorSupervisorDeps {
  create: () => Promise<SupervisedHermesMonitor | null>;
  retryMs?: number;
  now?: () => number;
  onError?: (error: Error) => void;
  setTimeoutImpl?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Owns monitor initialization only. The live monitor owns its own periodic
 * checks; this wrapper retries a failed config/state initialization without
 * letting Hermes silently disappear from Services.
 */
export class HermesMonitorSupervisor {
  private readonly deps: HermesMonitorSupervisorDeps;
  private monitor: SupervisedHermesMonitor | null = null;
  private inflight: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private started = false;
  private failedAt: string | null = null;

  constructor(deps: HermesMonitorSupervisorDeps) { this.deps = deps; }

  start(): Promise<void> {
    if (this.started) return this.inflight ?? Promise.resolve();
    this.started = true;
    this.stopped = false;
    return this.tryCreate();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      (this.deps.clearTimeoutImpl ?? clearTimeout)(this.retryTimer);
      this.retryTimer = null;
    }
    this.monitor?.stop();
    this.monitor = null;
  }

  serviceRows(): ServiceHealth[] {
    if (this.monitor) return this.monitor.serviceRows();
    if (!this.failedAt) return [];
    return [{
      id: 'hermes-fleet', label: 'Hermes fleet', kind: 'hermes', alwaysOn: true, group: 'Hermes fleet',
      status: 'unknown', detail: 'Hermes monitor initialization failed; retrying in background',
      pid: null, lastRun: null, nextRun: null, checkedAt: this.failedAt, autoHeal: false,
    }];
  }

  private tryCreate(): Promise<void> {
    if (this.stopped || this.monitor) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const candidate = await this.deps.create();
        if (this.stopped) {
          candidate?.stop();
          return;
        }
        if (!candidate) {
          this.failedAt = null;
          return;
        }
        candidate.start();
        this.monitor = candidate;
        this.failedAt = null;
      } catch (error) {
        if (this.stopped) return;
        this.failedAt = new Date((this.deps.now ?? Date.now)()).toISOString();
        this.deps.onError?.(error as Error);
        this.scheduleRetry();
      }
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const setTimer = this.deps.setTimeoutImpl ?? setTimeout;
    this.retryTimer = setTimer(() => {
      this.retryTimer = null;
      void this.tryCreate();
    }, this.deps.retryMs ?? 60_000);
    this.retryTimer.unref?.();
  }
}
