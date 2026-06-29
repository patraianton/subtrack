import type { NormalizedUsage } from './types.ts';

export class SnapshotStore {
  private readonly map = new Map<string, NormalizedUsage>();
  set(id: string, usage: NormalizedUsage): void {
    this.map.set(id, usage);
  }
  get(id: string): NormalizedUsage | undefined {
    return this.map.get(id);
  }
  all(): NormalizedUsage[] {
    return [...this.map.values()];
  }
}
