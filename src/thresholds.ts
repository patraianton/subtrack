import type { Severity } from './types.ts';

export function severityFor(util: number): Severity {
  if (util >= 90) return 'crit';
  if (util >= 70) return 'warn';
  return 'ok';
}
