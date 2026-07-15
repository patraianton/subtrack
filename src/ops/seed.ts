import type { ServiceDef, SystemState } from './types.ts';
import { loadServices, saveServices } from './config.ts';

const PERIODIC = /(_healthcheck|_summary|-summary|healthcheck|refresh)/i;

/** Build a first-pass manifest from what is already scheduled. One task -> one def. */
export function seedServices(sys: SystemState): ServiceDef[] {
  return sys.tasks.map((t) => ({
    id: t.name,
    label: t.name,
    kind: 'task' as const,
    taskName: t.name,
    alwaysOn: !PERIODIC.test(t.name),
    group: t.name.split(/[-_]/)[0] || undefined,
  }));
}

export async function ensureServices(base: string, sys: SystemState): Promise<ServiceDef[]> {
  const existing = await loadServices(base);
  if (existing.length > 0) return existing;
  const seeded = seedServices(sys);
  await saveServices(seeded, base);
  return seeded;
}
