import type { ServiceDef, ServiceHealth, ServicesResponse, SystemState, UntrackedRunner } from './types.ts';
import { gatherSystemState, type PwshRunner } from './windows.ts';
import { probeHttp } from './httpProbe.ts';
import { probeService } from './probe.ts';
import { ensureServices } from './seed.ts';

export interface ServicesDeps {
  base: string;
  run: PwshRunner;
  httpProbe?: typeof probeHttp;
  now?: () => number;
  cacheMs?: number;
  additionalServices?: () => ServiceHealth[];
}

function untrackedRunners(defs: ServiceDef[], sys: SystemState): UntrackedRunner[] {
  const claimedPorts = new Set(defs.map((d) => d.port).filter((p): p is number => p !== undefined));
  const out: UntrackedRunner[] = [];
  for (const port of sys.ports) {
    if (claimedPorts.has(port)) continue;
    const owner = sys.processes.find((p) => p.cmd.includes(`:${port}`)); // best-effort
    out.push({ kind: 'port', port, pid: owner?.pid ?? -1, name: owner?.name ?? '', cmd: owner?.cmd ?? '' });
  }
  return out;
}

async function build(deps: ServicesDeps): Promise<ServicesResponse> {
  const now = (deps.now ?? Date.now)();
  const httpProbe = deps.httpProbe ?? probeHttp;
  const sys = await gatherSystemState(deps.run, now);
  const defs = await ensureServices(deps.base, sys);
  const services: ServiceHealth[] = [];
  for (const def of defs) {
    let httpOk: boolean | undefined;
    if (def.kind === 'http' && def.port !== undefined) httpOk = await httpProbe(def.port, def.httpPath ?? '/', 1500);
    services.push(probeService(def, sys, httpOk));
  }
  if (deps.additionalServices) services.push(...deps.additionalServices());
  services.sort(byUrgency);
  return { services, untracked: untrackedRunners(defs, sys), generatedAt: new Date(now).toISOString() };
}

const RANK: Record<string, number> = { down: 0, degraded: 1, unknown: 2, up: 3 };
function byUrgency(a: ServiceHealth, b: ServiceHealth): number {
  const au = a.alwaysOn ? 0 : 1, bu = b.alwaysOn ? 0 : 1;   // always-on problems first
  if (au !== bu) return au - bu;
  return (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9);
}

/** Returns a cached provider: repeated calls within cacheMs reuse the last snapshot. */
export function makeGetServices(deps: ServicesDeps): () => Promise<ServicesResponse> {
  const cacheMs = deps.cacheMs ?? 10_000;
  const clock = deps.now ?? Date.now;
  let cached: ServicesResponse | null = null;
  let at = -Infinity;
  let inflight: Promise<ServicesResponse> | null = null;
  return async () => {
    const t = clock();
    if (cached && t - at < cacheMs) return cached;
    if (inflight) return inflight;
    inflight = build(deps).then((r) => { cached = r; at = clock(); inflight = null; return r; }, (e) => { inflight = null; throw e; });
    return inflight;
  };
}
