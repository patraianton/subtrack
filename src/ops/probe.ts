import type { ServiceDef, ServiceHealth, ServiceStatus, SystemState, TaskState, ProcInfo } from './types.ts';

type MatchResult =
  | { ok: 'no-pattern' }
  | { ok: 'invalid' }
  | { ok: 'found'; proc: ProcInfo }
  | { ok: 'absent' };

function matchProc(match: string | undefined, processes: ProcInfo[]): MatchResult {
  if (!match) return { ok: 'no-pattern' };
  let re: RegExp;
  try { re = new RegExp(match, 'i'); } catch { return { ok: 'invalid' }; }
  const proc = processes.find((p) => re.test(p.name) || re.test(p.cmd));
  return proc ? { ok: 'found', proc } : { ok: 'absent' };
}

// SCHED_S_* success/informational codes (0x41300–0x4130B: ready, running, not-yet-run, ...) are NOT failures.
function isBenignTaskResult(r: number | null): boolean {
  return r === null || r === 0 || (r >= 0x41300 && r <= 0x4130b);
}

function health(def: ServiceDef, status: ServiceStatus, detail: string, extra: Partial<ServiceHealth> = {}): ServiceHealth {
  return { ...def, status, detail, pid: null, lastRun: null, nextRun: null, ...extra };
}

function probeTask(def: ServiceDef, sys: SystemState): ServiceHealth {
  const t: TaskState | undefined = sys.tasks.find((x) => x.name === def.taskName);
  if (!t) return health(def, 'down', `task "${def.taskName}" not registered`);
  const base = { lastRun: t.lastRun, nextRun: t.nextRun };
  if (t.state === 'Disabled') return health(def, 'down', 'task disabled', base);
  if (!isBenignTaskResult(t.lastResult)) {
    return health(def, 'degraded', `last run failed (0x${(t.lastResult as number).toString(16).toUpperCase()})`, base);
  }
  if (def.alwaysOn && def.port !== undefined) {
    return sys.ports.includes(def.port)
      ? health(def, 'up', `task ${t.state}, listening :${def.port}`, base)
      : health(def, 'degraded', `task ${t.state} but nothing on :${def.port}`, base);
  }
  if (def.alwaysOn && def.match) {
    const m = matchProc(def.match, sys.processes);
    if (m.ok === 'invalid') return health(def, 'unknown', `invalid match regex: ${def.match}`, base);
    if (m.ok === 'found') return health(def, 'up', `task ${t.state}, process ${m.proc.pid}`, { ...base, pid: m.proc.pid });
    return health(def, 'degraded', `task ${t.state} but no matching process`, base);
  }
  return health(def, 'up', `task ${t.state}`, base);
}

export function probeService(def: ServiceDef, sys: SystemState, httpOk?: boolean): ServiceHealth {
  switch (def.kind) {
    case 'port': {
      const on = def.port !== undefined && sys.ports.includes(def.port);
      return on ? health(def, 'up', `listening :${def.port}`) : health(def, 'down', `nothing on :${def.port}`);
    }
    case 'http': {
      if (httpOk === true) return health(def, 'up', `http 2xx on :${def.port}${def.httpPath ?? ''}`);
      const listening = def.port !== undefined && sys.ports.includes(def.port);
      if (httpOk === undefined) return health(def, 'unknown', 'http probe errored');
      return listening
        ? health(def, 'degraded', `:${def.port} listening but ${def.httpPath ?? '/'} not 2xx`)
        : health(def, 'down', `no http on :${def.port}`);
    }
    case 'process': {
      const m = matchProc(def.match, sys.processes);
      if (m.ok === 'no-pattern') return health(def, 'unknown', 'no match pattern configured');
      if (m.ok === 'invalid') return health(def, 'unknown', `invalid match regex: ${def.match}`);
      if (m.ok === 'found') return health(def, 'up', `process ${m.proc.pid} (${m.proc.name})`, { pid: m.proc.pid });
      return health(def, 'down', 'no matching process');
    }
    case 'task':
      return probeTask(def, sys);
    case 'hermes':
      return health(def, 'unknown', 'Hermes rows are supplied by the background fleet monitor');
    // Reachable: services.json is cast to ServiceDef without runtime validation, so an unrecognized kind can arrive here.
    default:
      return health(def, 'unknown', `unknown kind "${(def as ServiceDef).kind}"`);
  }
}
