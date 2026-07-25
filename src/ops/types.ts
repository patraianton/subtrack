export type ServiceKind = 'task' | 'process' | 'port' | 'http' | 'hermes';
export type ServiceStatus = 'up' | 'down' | 'degraded' | 'unknown';

export interface ServiceDef {
  id: string;
  label: string;
  kind: ServiceKind;
  taskName?: string;   // for kind 'task' + restart
  port?: number;       // for kind 'port' / 'http', or as a health signal for a 'task'
  httpPath?: string;   // for kind 'http'
  match?: string;      // JS regex source, tested against a process's name and cmd
  startCmd?: string;   // how to (re)start when unregistered (Phase 1: stored only)
  cwd?: string;
  alwaysOn: boolean;   // expected continuously up (red when down) vs periodic
  group?: string;
}

export interface TaskState {
  name: string;
  state: string;               // 'Running' | 'Ready' | 'Disabled' | ...
  lastResult: number | null;   // Get-ScheduledTaskInfo LastTaskResult (0 = ok)
  lastRun: string | null;
  nextRun: string | null;
}

export interface ProcInfo { pid: number; name: string; cmd: string }

export interface SystemState {
  tasks: TaskState[];
  ports: number[];       // listening loopback ports
  processes: ProcInfo[];
  now: number;           // ms epoch (injected clock)
}

export interface ServiceHealth extends ServiceDef {
  status: ServiceStatus;
  detail: string;              // one-line human reason
  pid: number | null;
  lastRun: string | null;
  nextRun: string | null;
  /** Background-monitor metadata. These fields never contain credential paths or tokens. */
  checkedAt?: string;
  subscription?: string;
  autoHeal?: boolean;
  lastRestartAt?: string | null;
  consecutiveFailures?: number;
}

export interface UntrackedRunner {
  kind: 'port' | 'process';
  port: number | null;
  pid: number;
  name: string;
  cmd: string;
}

export interface ServicesResponse {
  services: ServiceHealth[];
  untracked: UntrackedRunner[];
  generatedAt: string;         // ISO
}

export interface ActionRequest {
  action: 'restart' | 'stop' | 'register';
  id?: string;    // for restart/stop: the ServiceDef.id
  pid?: number;   // for register: the untracked runner's pid
  label?: string; // for register: desired task name (sanitized server-side)
}

export interface ActionResult {
  ok: boolean;
  ran: string;          // short human description of what was attempted
  output?: string;      // trimmed stdout/stderr tail, for display
  error?: string;       // set when ok is false
  taskName?: string;    // for register: the created task's name
}
