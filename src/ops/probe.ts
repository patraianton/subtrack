import type { ServiceDef, ServiceHealth, ServiceStatus, SystemState, TaskState, ProcInfo } from './types.ts';

function matchProc(match: string | undefined, processes: ProcInfo[]): ProcInfo | undefined {
  if (!match) return undefined;
  let re: RegExp;
  try { re = new RegExp(match, 'i'); } catch { return undefined; }
  return processes.find((p) => re.test(p.name) || re.test(p.cmd));
}

function health(def: ServiceDef, status: ServiceStatus, detail: string, extra: Partial<ServiceHealth> = {}): ServiceHealth {
  return { ...def, status, detail, pid: null, lastRun: null, nextRun: null, ...extra };
}

function probeTask(def: ServiceDef, sys: SystemState): ServiceHealth {
  const t: TaskState | undefined = sys.tasks.find((x) => x.name === def.taskName);
  if (!t) return health(def, 'down', `task "${def.taskName}" not registered`);
  const base = { lastRun: t.lastRun, nextRun: t.nextRun };
  if (t.state === 'Disabled') return health(def, 'down', 'task disabled', base);
  if (t.lastResult !== null && t.lastResult !== 0) {
    return health(def, 'degraded', `last run failed (0x${t.lastResult.toString(16).toUpperCase()})`, base);
  }
  if (def.alwaysOn && def.port !== undefined) {
    return sys.ports.includes(def.port)
      ? health(def, 'up', `task ${t.state}, listening :${def.port}`, base)
      : health(def, 'degraded', `task ${t.state} but nothing on :${def.port}`, base);
  }
  if (def.alwaysOn && def.match) {
    const p = matchProc(def.match, sys.processes);
    return p
      ? health(def, 'up', `task ${t.state}, process ${p.pid}`, { ...base, pid: p.pid })
      : health(def, 'degraded', `task ${t.state} but no matching process`, base);
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
      const p = matchProc(def.match, sys.processes);
      return p ? health(def, 'up', `process ${p.pid} (${p.name})`, { pid: p.pid }) : health(def, 'down', 'no matching process');
    }
    case 'task':
      return probeTask(def, sys);
    default:
      return health(def, 'unknown', `unknown kind "${(def as ServiceDef).kind}"`);
  }
}
